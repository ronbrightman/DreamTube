// test/scroll-lock-behavioral.test.js
//
// Unit/behavioral coverage for js/scroll-lock.js — the shared, iOS-robust,
// ref-counted scroll lock adopted by both full-screen overlays (the
// Interpreter's Chamber in js/interpret-experience.js and result.html's
// fallback video player). Tracker item
// for-product-bug-founder-video-08-07-resu-f4u8zy and its same-family home.html
// repro: after closing a full-screen overlay the page would no longer scroll
// on iOS Safari.
//
// The helper attaches to window on load and drives the REAL DOM, so this
// exercises it inside a real browser (Chromium) rather than a hand-rolled DOM
// stub. It is loaded by result.html already (before js/interpret-experience.js),
// which also gives us a real inner `.scroll-area` scroller to lock — so these
// tests seed result.html and then call window.ScrollLock.* directly, asserting
// the state machine (ref-count, lock/unlock, scroll restoration, nesting, and
// the pagehide/pageshow backstops).
//
// Why we can't force the actual iOS freeze here: this sandbox has no WebKit
// engine (Chromium only) and `-webkit-overflow-scrolling` momentum is a
// WebKit-only behavior, so the specific frozen-momentum-layer symptom can't
// be reproduced headlessly. What IS reproduced and asserted here is the exact
// STATE MACHINE the fix relies on — the lock is applied to and released from
// the real scroller, the scroll position is preserved, ref-counting balances,
// and the bfcache backstops force a clean release — which is the portable,
// engine-independent contract the iOS remedy is built on top of.
//
// Follows test/result-scroll-lock-behavioral.test.js's own seedResultPage/
// blockThirdParty conventions.

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

// Seed a logged-in account with a long dream so result.html's inner
// `.scroll-area` genuinely overflows the (short) viewport — otherwise there is
// no scroll state to lock/restore and the helper (correctly) skips it.
async function seedResultPage(page, dreamId) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (id) {
    var raw = localStorage.getItem('dreamtube_state_v1');
    var state = raw ? JSON.parse(raw) : {};
    state.user = { handle: '@tester', username: 'tester' };
    state.accounts = { tester: { password: 'testpass1', email: 'tester@example.com' } };
    state.dreams = [{
      id: id, ownerHandle: '@tester',
      caption: 'A test dream about flying over mountains, endless and calm ',
      storyText: 'I was flying over mountains, free and calm. '.repeat(60),
      style: 'Cinematic',
      videoUrl: 'https://example.com/fake-video.mp4',
      isPublished: false, createdAt: new Date().toISOString()
    }];
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(state));
  }, dreamId);
  await page.goto(baseUrl + '/result.html?id=' + dreamId, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scroll-area', { timeout: 5000 });
}

function lockState(page) {
  return page.evaluate(function () {
    var sa = document.querySelector('.scroll-area');
    return {
      hasHelper: typeof window.ScrollLock === 'object' && window.ScrollLock !== null,
      refCount: window.ScrollLock ? window.ScrollLock._refCount() : null,
      isLocked: window.ScrollLock ? window.ScrollLock.isLocked() : null,
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      scrollerOverflow: sa ? sa.style.overflow : null,
      scrollerScrollTop: sa ? sa.scrollTop : null,
      scrollerCanScroll: sa ? (sa.scrollHeight - sa.clientHeight > 1) : null
    };
  });
}

// result.html is a dual-scroller layout: with short content only the inner
// `.scroll-area` scrolls; with long content the document itself scrolls too.
// The helper deliberately covers BOTH (position:fixed for a body/window
// scroller, momentum-rebuild for an inner scroller). These probes assert the
// observable contract — "locked = can't move, unlocked = position restored and
// moves again" — without hard-coding which scroller is active, so the test is
// robust to that layout ambiguity.
function installScrollProbe(page) {
  return page.evaluate(function () {
    window.__sp = {
      scrollers: function () {
        var out = [];
        var de = document.scrollingElement || document.documentElement;
        if (de && de.scrollHeight - de.clientHeight > 1) {
          out.push({ kind: 'doc', get: function () { return window.pageYOffset; }, set: function (v) { window.scrollTo(0, v); } });
        }
        var sa = document.querySelector('.scroll-area');
        if (sa && sa.scrollHeight - sa.clientHeight > 1) {
          out.push({ kind: 'inner', get: function () { return sa.scrollTop; }, set: function (v) { sa.scrollTop = v; } });
        }
        return out;
      }
    };
    return window.__sp.scrollers().map(function (s) { return s.kind; });
  });
}
// Scroll every active scroller to `target`, return the resulting positions.
function setScroll(page, target) {
  return page.evaluate(function (t) {
    return window.__sp.scrollers().map(function (s) { s.set(t); return { kind: s.kind, pos: s.get() }; });
  }, target);
}
function getScroll(page) {
  return page.evaluate(function () {
    return window.__sp.scrollers().map(function (s) { return { kind: s.kind, pos: s.get() }; });
  });
}

test('scroll-lock: the helper is present on result.html and starts fully unlocked (ref-count 0, nothing touched)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 640 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'sl-present');

    var s = await lockState(page);
    assert.equal(s.hasHelper, true, 'window.ScrollLock is defined (js/scroll-lock.js loaded)');
    assert.equal(s.refCount, 0, 'starts at ref-count 0');
    assert.equal(s.isLocked, false);
    assert.equal(s.scrollerCanScroll, true, 'precondition: the inner .scroll-area actually overflows so there is real scroll state to lock');
    // The fix's whole point: the body itself is never the lock surface.
    assert.equal(s.bodyOverflow, '', 'body overflow is never touched by the helper');
    assert.equal(s.bodyPosition, '', 'body position is never touched on this inner-scroller page');
  } finally {
    await context.close();
  }
});

test('scroll-lock: lock() freezes the active scroller (page can\'t move); unlock() releases it, restores the scroll position, and leaves the page scrollable again (no freeze)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 640 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'sl-lock-unlock');

    var kinds = await installScrollProbe(page);
    assert.ok(kinds.length > 0, 'precondition: at least one scroller is active on result.html');

    // Scroll each active scroller to its max, as a user would before opening
    // an overlay. Capture the actual (clamped) position per scroller.
    var openPos = {};
    (await setScroll(page, 100000)).forEach(function (s) {
      assert.ok(s.pos > 0, s.kind + ' scroller is scrolled down before locking');
      openPos[s.kind] = s.pos;
    });

    // ---- lock ----
    await page.evaluate(function () { window.ScrollLock.lock(); });
    var locked = await lockState(page);
    assert.equal(locked.refCount, 1, 'ref-count is 1 after one lock()');
    assert.equal(locked.isLocked, true);
    // A real lock mechanism must be engaged — overflow:hidden on the inner
    // scroller (blocks touch scroll behind the overlay) and/or position:fixed
    // on the body when the document itself is the scroller. (These block the
    // touch/user scroll that the overlay is covering; a programmatic scrollTop
    // can still bypass overflow:hidden in Chromium, so the engaged mechanism —
    // not a scripted scroll attempt — is the observable lock here.)
    assert.ok(locked.scrollerOverflow === 'hidden' || locked.bodyPosition === 'fixed',
      'a real lock mechanism is engaged (overflow:hidden on the inner scroller and/or position:fixed on the body)');

    // ---- unlock ----
    await page.evaluate(function () { window.ScrollLock.unlock(); });
    var released = await lockState(page);
    assert.equal(released.refCount, 0, 'ref-count returns to 0 after the matching unlock()');
    assert.equal(released.isLocked, false);
    assert.equal(released.scrollerOverflow, '', 'any inner-scroller overflow lock is cleared');
    assert.equal(released.bodyPosition, '', 'any body position:fixed lock is cleared');

    // The exact scroll position is restored on release.
    (await getScroll(page)).forEach(function (s) {
      assert.equal(s.pos, openPos[s.kind], s.kind + ' scroll position is restored to where the user was');
    });

    // And the page is usable again — the founder-reported symptom was that it
    // was NOT (frozen). A scroll after unlock must actually move.
    (await setScroll(page, 20)).forEach(function (s) {
      assert.equal(s.pos, 20, s.kind + ' scroller responds to a scroll after unlock — it is not frozen');
    });
  } finally {
    await context.close();
  }
});

test('scroll-lock: ref-counting — nested lock(); lock(); unlock(); keeps the page locked (something is still open); the second unlock() releases exactly once', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 640 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'sl-refcount');

    await page.evaluate(function () { window.ScrollLock.lock(); window.ScrollLock.lock(); });
    var two = await lockState(page);
    assert.equal(two.refCount, 2, 'two overlapping overlays -> ref-count 2');
    assert.equal(two.scrollerOverflow, 'hidden');

    await page.evaluate(function () { window.ScrollLock.unlock(); });
    var one = await lockState(page);
    assert.equal(one.refCount, 1, 'closing one of two overlays does NOT release the page');
    assert.equal(one.isLocked, true);
    assert.equal(one.scrollerOverflow, 'hidden', 'still locked while the other overlay is open');

    await page.evaluate(function () { window.ScrollLock.unlock(); });
    var zero = await lockState(page);
    assert.equal(zero.refCount, 0, 'the last unlock() releases it');
    assert.equal(zero.scrollerOverflow, '');

    // Underflow guard: an extra unlock() must not drive ref-count negative.
    await page.evaluate(function () { window.ScrollLock.unlock(); });
    var extra = await lockState(page);
    assert.equal(extra.refCount, 0, 'an unbalanced extra unlock() cannot underflow the ref-count');
  } finally {
    await context.close();
  }
});

test('scroll-lock: forceRelease() and the pagehide backstop drop a held lock to zero regardless of ref-count (the bfcache edge-swipe-back path)', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext({ viewport: { width: 390, height: 640 } });
  try {
    var page = await context.newPage();
    await blockThirdParty(page);
    await seedResultPage(page, 'sl-forcerelease');

    // Hold two locks, then simulate the page being frozen for bfcache (the
    // exact event iOS Safari fires on an edge-swipe back, which runs no close
    // handlers). The helper's own pagehide listener must force a full release.
    await page.evaluate(function () { window.ScrollLock.lock(); window.ScrollLock.lock(); });
    assert.equal((await lockState(page)).refCount, 2);

    await page.evaluate(function () { window.dispatchEvent(new Event('pagehide')); });
    var afterHide = await lockState(page);
    assert.equal(afterHide.refCount, 0, 'pagehide force-releases even with ref-count 2 held — a restored page can never come back locked');
    assert.equal(afterHide.scrollerOverflow, '', 'the scroller lock is cleared by the backstop');

    // pageshow{persisted:true} is the restore-side net; re-hold a lock, then
    // fire it and confirm it also force-releases.
    await page.evaluate(function () {
      window.ScrollLock.lock();
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    var afterShow = await lockState(page);
    assert.equal(afterShow.refCount, 0, 'pageshow{persisted:true} force-releases as defense-in-depth');
    assert.equal(afterShow.scrollerOverflow, '');
  } finally {
    await context.close();
  }
});
