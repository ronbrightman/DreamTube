// test/result-scroll-lock-behavioral.test.js
//
// Regression coverage for tracker item
// for-product-bug-founder-video-08-07-resu-f4u8zy (founder screen recording,
// dreamtube.life result.html on iPhone Safari) and its same-family home.html
// repro: after closing a full-screen overlay the page went
// mid-content-but-entirely-unscrollable — swiping only rubber-banded into
// Safari's pull-to-refresh instead of scrolling.
//
// Root cause (see js/scroll-lock.js's header for the full write-up): the
// overlays toggled `document.body.style.overflow`, but on this app's pages the
// window/body is not the scroller — the real scroller is an inner
// `overflow-y:auto; -webkit-overflow-scrolling:touch` region (result.html
// `.scroll-area`, home.html `.home-scroll`), and with long content the
// document itself can scroll too. Mutating overflow on an ANCESTOR of a
// momentum scroller while it is scrolled froze that scroller on iOS until a
// reflow rebuilt its momentum layer.
//
// The FIX moved every overlay onto the shared, ref-counted, iOS-robust
// js/scroll-lock.js (window.ScrollLock): it never touches body overflow,
// locks the real scroller(s), and on release rebuilds the iOS momentum layer +
// restores scroll position. This suite verifies the two real overlays on
// result.html — the Interpreter's Chamber (js/interpret-experience.js) and the
// fallback video player — drive that lock correctly, including on the
// bfcache/edge-swipe-back path that no explicit Close button can reach.
//
// This suite can't force a real iOS bfcache freeze/restore inside Chromium+CDP
// (bfcache is unreliable under DevTools Protocol, and this sandbox has no
// WebKit engine at all — see AGENT_POLICY.md's REAL-MODE gate discussion of
// engine-specific gaps). Instead it dispatches the exact `pagehide`/`pageshow`
// events every browser (iOS Safari included) fires around a bfcache
// freeze/restore, which is the standard portable way to exercise that cleanup
// path. See test/scroll-lock-behavioral.test.js for the helper's own
// state-machine coverage (ref-count, restore, nesting).
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
      storyText: 'I was flying over mountains, free and calm. '.repeat(20),
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

// The lock now lives in window.ScrollLock and targets the real scroller(s),
// never document.body.style.overflow. Read the state that actually matters.
function readLockState(page) {
  return page.evaluate(function () {
    var root = document.getElementById('itp-root');
    var sa = document.querySelector('.scroll-area');
    return {
      refCount: window.ScrollLock ? window.ScrollLock._refCount() : null,
      isLocked: window.ScrollLock ? window.ScrollLock.isLocked() : null,
      itpOpen: root ? root.classList.contains('open') : false,
      scrollerOverflow: sa ? sa.style.overflow : null,
      bodyPosition: document.body.style.position,
      // The fix's contract: the naked body-overflow toggle that caused the
      // freeze is gone for good.
      bodyOverflow: document.body.style.overflow
    };
  });
}

test('result.html: opening the interpretation overlay engages the shared scroll lock (ref-count 1), and the topbar Close button releases it (ref-count 0) — never via a raw body-overflow toggle', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-scrolllock-baseline');

    var before = await readLockState(page);
    assert.equal(before.refCount, 0, 'no lock before the overlay is ever opened');
    assert.equal(before.bodyOverflow, '', 'body overflow is never used as the lock');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var whileOpen = await readLockState(page);
    assert.equal(whileOpen.refCount, 1, 'the shared scroll lock is held while the overlay is open');
    assert.equal(whileOpen.isLocked, true);
    assert.equal(whileOpen.itpOpen, true);
    assert.ok(whileOpen.scrollerOverflow === 'hidden' || whileOpen.bodyPosition === 'fixed',
      'a real scroller lock is engaged (inner overflow:hidden and/or body position:fixed)');
    // The freeze-causing bug was a NAKED body-overflow toggle. The fix never
    // sets body overflow alone — when the document is the scroller it uses the
    // full iOS-safe position:fixed technique (of which overflow:hidden is one
    // part), so body overflow being set implies position:fixed is too.
    assert.ok(whileOpen.bodyOverflow === '' || whileOpen.bodyPosition === 'fixed',
      'body overflow is never toggled alone (the freeze cause) — only ever as part of the position:fixed technique');

    await page.click('#itp-close-btn');
    await page.waitForTimeout(50);

    var afterClose = await readLockState(page);
    assert.equal(afterClose.refCount, 0, 'the topbar Close button releases the lock');
    assert.equal(afterClose.isLocked, false);
    assert.equal(afterClose.itpOpen, false);
    assert.equal(afterClose.scrollerOverflow, '', 'the inner-scroller lock is cleared on close');
    assert.equal(afterClose.bodyPosition, '', 'the body position lock is cleared on close');
  } finally {
    await context.close();
  }
});

test('result.html: abandoning the interpretation overlay open (no explicit close) then a pagehide — the exact sequence iOS Safari\'s edge-swipe back gesture (and any bfcache-eligible navigation-away) produces — still releases the scroll lock', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await mockInterpretDream(page, {});
    await seedResultPage(page, 'd-scrolllock-pagehide');

    await page.click('#interp-cta-btn');
    await page.waitForSelector('.itp-persona-card[data-key="jung"]', { state: 'visible', timeout: 5000 });

    var whileOpen = await readLockState(page);
    assert.equal(whileOpen.refCount, 1, 'precondition: overlay open, lock held, exactly as it would be mid-gesture');

    // Never tap Close — simulate the page being hidden/frozen for bfcache
    // storage (what a real edge-swipe-back or any navigation-away does) by
    // dispatching the same event the browser fires right before that freeze.
    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });

    var afterPagehide = await readLockState(page);
    assert.equal(afterPagehide.refCount, 0, 'pagehide releases the lock even though no Close button was tapped — this is the actual regression path');
    assert.equal(afterPagehide.itpOpen, false, 'the interpretation session is torn down (not just the lock) so a bfcache restore does not also show a stuck-open overlay');
    assert.equal(afterPagehide.scrollerOverflow, '', 'the inner-scroller lock is cleared');
    assert.equal(afterPagehide.bodyPosition, '', 'the body position lock is cleared');

    // Restore side: pageshow{persisted:true} is what fires when a bfcache-frozen
    // page comes back. Re-hold a lock and confirm the helper's own backstop
    // force-releases it (defense-in-depth for a pre-fix frozen entry).
    await page.evaluate(function () {
      window.ScrollLock.lock();
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    var afterPageshow = await readLockState(page);
    assert.equal(afterPageshow.refCount, 0, 'pageshow{persisted:true} force-releases any still-held lock, independent of session state');
  } finally {
    await context.close();
  }
});

test('result.html: the fallback video player engages and releases the SAME shared scroll lock (founder\'s stated "returning from the video player" repro path)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    // ?play=1 opens the in-app overlay player directly (the fallback path used
    // when native fullscreen isn't available/allowed — see result.html's
    // fullscreen IIFE), which is exactly the overlay whose close froze the page.
    await seedResultPage(page, 'd-player-lock');
    await page.goto(baseUrl + '/result.html?id=d-player-lock&play=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#player-overlay.open', { timeout: 5000 });

    var whileOpen = await readLockState(page);
    assert.equal(whileOpen.refCount, 1, 'the video player holds the shared scroll lock while open');
    assert.ok(whileOpen.scrollerOverflow === 'hidden' || whileOpen.bodyPosition === 'fixed',
      'a real scroller lock is engaged behind the player');
    assert.ok(whileOpen.bodyOverflow === '' || whileOpen.bodyPosition === 'fixed',
      'body overflow is never toggled alone (the freeze cause) — only ever as part of the position:fixed technique');

    await page.click('#player-close-btn');
    await page.waitForTimeout(50);

    var afterClose = await readLockState(page);
    assert.equal(afterClose.refCount, 0, 'closing the player releases the lock — the page is scrollable again');
    assert.equal(afterClose.scrollerOverflow, '');
    assert.equal(afterClose.bodyPosition, '');
    var stillOpen = await page.evaluate(function () { return document.getElementById('player-overlay').classList.contains('open'); });
    assert.equal(stillOpen, false, 'the player overlay is closed');
  } finally {
    await context.close();
  }
});

test('result.html: js/scroll-lock.js never underflows — a pagehide with no lock held is a harmless no-op (ref-count stays 0, nothing corrupted)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 700 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'd-scrolllock-noop');

    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });

    var state = await readLockState(page);
    assert.equal(state.refCount, 0, 'pagehide with nothing locked leaves the ref-count at 0');
    assert.equal(state.isLocked, false);
    assert.equal(state.scrollerOverflow, '', 'no scroller lock is spuriously applied or left behind');
    assert.equal(state.bodyPosition, '', 'the body is never touched when nothing was locked');
  } finally {
    await context.close();
  }
});
