// js/scroll-lock.js
//
// One shared, iOS-robust, ref-counted scroll lock for every full-screen
// overlay in the app (the Interpreter's Chamber in js/interpret-experience.js
// and result.html's fallback video player today; any future overlay/sheet
// that needs to freeze the page behind it should call this too instead of
// touching overflow itself).
//
// ── Why this exists (the founder bug it kills) ────────────────────────────
// Twice-reproduced, iOS Safari only: after closing a full-screen overlay and
// returning to a scrollable page (home.html, result.html), the page would no
// longer scroll — a touch-drag only rubber-banded into Safari's
// pull-to-refresh instead of moving the content. Seen returning from the
// fallback video player to result.html, and from Dream Interpretation back to
// home. Same family, same cause.
//
// Root cause: js/interpret-experience.js's open()/close() toggled
// `document.body.style.overflow` between 'hidden' and ''. On this app's pages
// the WINDOW/BODY is not the scroller at all — html/body are height:100%,
// #app is a fixed-height flex shell (overflow:hidden), and the ACTUAL
// scroller is an inner `overflow-y:auto; -webkit-overflow-scrolling:touch`
// region (home.html `.home-scroll`, result.html and the shared base class
// `.scroll-area`). Mutating overflow on an ANCESTOR (body) of a momentum
// (`-webkit-overflow-scrolling:touch`) scroller while it is scrolled is a
// well-known iOS Safari bug: it invalidates the descendant's momentum-scroll
// layer and leaves it frozen until that layer is rebuilt by a reflow. The
// body toggle was also gratuitous for its stated purpose — the overlays are
// `position:fixed; inset:0; pointer-events:auto` when open, so they already
// cover the page and capture every touch; the background cannot scroll while
// one is open regardless of any overflow lock.
//
// ── What this helper does instead ─────────────────────────────────────────
// It NEVER touches `document.body.style.overflow`. It locks the real inner
// scroller(s) directly, and on release it explicitly rebuilds the iOS
// momentum-scroll layer (toggle `-webkit-overflow-scrolling` + force a
// reflow) before restoring scrollTop — the canonical remedy for the exact
// freeze above. It also handles genuine window/body-scroller pages (should
// any exist) with the standard `position:fixed; top:-scrollY` technique,
// guarded so it is a no-op on the inner-scroller pages this app actually has.
//
// Ref-counted so overlapping overlays (open A, open B, close A, close B)
// don't unlock the page while something is still open, and so a stuck
// mismatch can't leave it permanently locked. `pagehide`/`pageshow` backstops
// force a full release for the one path an explicit close() can't reach: iOS
// Safari's edge-swipe back gesture, which runs no click handlers and can
// freeze the page into the back/forward cache mid-lock.
//
// No build step / no ES modules (see CLAUDE.md): plain IIFE exposing
// window.ScrollLock, with a CommonJS export tail purely so node:test can
// require() it directly for unit coverage.

(function () {
  'use strict';

  var win = typeof window !== 'undefined' ? window : null;
  var doc = typeof document !== 'undefined' ? document : null;

  var refCount = 0;

  // Captured at the 0->1 lock transition, replayed at the 1->0 release.
  var winLocked = false;
  var savedWinY = 0;
  var lockedScrollers = []; // [{ el, top }]

  // The app's real scrollers on its scrollable pages are inner
  // overflow-y:auto shells, NOT the window. `.scroll-area` is the shared base
  // class (css/styles.css); `.home-scroll` is home.html's page-local one.
  var SCROLLER_SELECTOR = '.scroll-area, .home-scroll';

  function scrollingEl() {
    return (doc && (doc.scrollingElement || doc.documentElement)) || null;
  }

  // True only when the window/body itself is the scroller (some other page
  // could be; this app's home/result pages are not — #app is overflow:hidden
  // and the inner region scrolls). Kept so the helper is correct everywhere.
  function windowIsScroller() {
    var el = scrollingEl();
    return !!el && (el.scrollHeight - el.clientHeight > 1);
  }

  function innerScrollers() {
    if (!doc) return [];
    var found = doc.querySelectorAll(SCROLLER_SELECTOR);
    return Array.prototype.filter.call(found, function (el) {
      // Only bother with ones that are (or could be) scrolled — a
      // non-overflowing region has no state to preserve and needs no lock.
      return (el.scrollHeight - el.clientHeight > 1) || el.scrollTop > 0;
    });
  }

  function applyLock() {
    // (a) Window/body-scroller pages: the standard iOS-safe position:fixed
    //     technique (freeze the body offset, restore scroll on release).
    //     Guarded so it never runs on this app's inner-scroller pages, where
    //     it would be a no-op at best and a layout jump at worst.
    if (win && doc && windowIsScroller()) {
      savedWinY = win.pageYOffset || (scrollingEl() ? scrollingEl().scrollTop : 0) || 0;
      var b = doc.body.style;
      b.position = 'fixed';
      b.top = (-savedWinY) + 'px';
      b.left = '0';
      b.right = '0';
      b.width = '100%';
      b.overflow = 'hidden';
      winLocked = true;
    }

    // (b) Inner overflow scrollers: this app's real model. Record scrollTop,
    //     then hide overflow. (The open overlay already covers the page, so
    //     this is invisible; it's a true lock for any future overlay that
    //     isn't full-viewport, and ref-counting keeps concurrent ones safe.)
    lockedScrollers = innerScrollers().map(function (el) {
      var top = el.scrollTop;
      el.style.overflow = 'hidden';
      return { el: el, top: top };
    });
  }

  function releaseLock() {
    if (winLocked) {
      var b = doc.body.style;
      b.position = '';
      b.top = '';
      b.left = '';
      b.right = '';
      b.width = '';
      b.overflow = '';
      winLocked = false;
      if (win && win.scrollTo) win.scrollTo(0, savedWinY);
      savedWinY = 0;
    }

    lockedScrollers.forEach(function (s) {
      var el = s.el;
      el.style.overflow = '';
      // iOS Safari: an overflow mutation can leave a
      // `-webkit-overflow-scrolling:touch` scroller frozen until its momentum
      // layer is rebuilt. Dropping momentum to 'auto', forcing a reflow, then
      // restoring it is the canonical fix — this is the whole point of the
      // helper, so do it unconditionally (it's a couple of style writes and a
      // layout read; harmless on non-iOS engines).
      el.style.webkitOverflowScrolling = 'auto';
      // eslint-disable-next-line no-unused-expressions
      void el.offsetHeight; // force synchronous reflow
      el.scrollTop = s.top;  // restore where the user was
      // Restore momentum on the NEXT frame, not synchronously. iOS Safari
      // often fails to rebuild the `-webkit-overflow-scrolling:touch` layer
      // when 'auto' and 'touch' are toggled inside a single frame — the
      // reflow above hasn't been PAINTED yet, so flipping straight back to
      // 'touch' can rebuild nothing and leave the scroller frozen anyway.
      // This is exactly the "scroll stuck after closing the interpretation"
      // freeze the founder still hit (2026-08-09) even with the ref count
      // balanced: the single open→close path was correct, but the momentum
      // rebuild wasn't reliable. Spanning a paint makes it reliable. The
      // element ref is captured per-iteration, so a scroller re-locked before
      // this fires is unaffected (overflow, not this hint, is what locks).
      (function (node) {
        if (win && win.requestAnimationFrame) win.requestAnimationFrame(function () { node.style.webkitOverflowScrolling = ''; });
        else node.style.webkitOverflowScrolling = '';
      })(el);
    });
    lockedScrollers = [];
  }

  // Sweep the LIVE DOM for any scroller carrying leftover inline lock styles
  // and clear them (rebuilding iOS momentum the same way releaseLock does).
  // releaseLock only knows the scrollers it captured at lock time; this heals
  // a scroller whose inline `overflow:hidden` / momentum hint leaked through a
  // path that release never saw — e.g. the page frozen into the bfcache
  // mid-release so releaseLock's next-frame momentum-restore never fired, or a
  // scroller that wasn't in the captured set. Safe to call anytime: a scroller
  // with no inline lock styles is left completely untouched. This is the
  // belt-and-suspenders half of the "scroll stuck again on home" fix
  // (founder 2026-08-15) — the invariant that no scroller can stay frozen once
  // nothing holds the lock.
  function sanitizeScrollers() {
    if (!doc) return;
    var all = doc.querySelectorAll(SCROLLER_SELECTOR);
    Array.prototype.forEach.call(all, function (el) {
      var hasHiddenOverflow = el.style.overflow === 'hidden';
      var hasMomentumHint = !!el.style.webkitOverflowScrolling &&
        el.style.webkitOverflowScrolling !== '';
      if (!hasHiddenOverflow && !hasMomentumHint) return; // clean — don't touch
      el.style.overflow = '';
      el.style.webkitOverflowScrolling = 'auto';
      // eslint-disable-next-line no-unused-expressions
      void el.offsetHeight; // force synchronous reflow (see releaseLock)
      (function (node) {
        if (win && win.requestAnimationFrame) win.requestAnimationFrame(function () { node.style.webkitOverflowScrolling = ''; });
        else node.style.webkitOverflowScrolling = '';
      })(el);
    });
  }

  function lock() {
    refCount += 1;
    if (refCount === 1) applyLock();
  }

  function unlock() {
    if (refCount === 0) return; // never underflow
    refCount -= 1;
    if (refCount === 0) releaseLock();
  }

  // Unconditional full release, ignoring the ref count. For the backstops
  // (page hidden/frozen/restored) and any "get me out of a stuck state" need.
  // Follows the normal release (restore captured scrollers + scroll positions)
  // with a live-DOM sweep so a scroller that leaked lock styles outside the
  // captured set is healed too — nothing can stay frozen after this returns.
  function forceRelease() {
    refCount = 0;
    releaseLock();
    sanitizeScrollers();
  }

  function isLocked() {
    return refCount > 0;
  }

  // Public "guarantee the page is scrollable" call for a page that KNOWS
  // nothing should currently be locked (e.g. home.html on becoming visible
  // again with no overlay open — see its installScrollSelfHeal guard). Alias
  // of forceRelease today; named for intent at the call site, and so a page
  // can feature-detect it. A page MUST check its own overlays are closed
  // before calling — ScrollLock itself can't tell a leak from a legitimately
  // open overlay's lock.
  function ensureReleased() {
    forceRelease();
  }

  // ── bfcache / navigation backstops ──────────────────────────────────────
  // `pagehide` fires right before a page is hidden or frozen into the
  // back/forward cache (iOS Safari included, unlike `beforeunload`), covering
  // the edge-swipe-back gesture that runs no click handlers. `pageshow` with
  // persisted:true is the restore side, defense-in-depth for an entry that was
  // frozen while locked (e.g. from before this shipped). Both just force a
  // full release — restoring a page can never legitimately want it locked.
  if (win) {
    win.addEventListener('pagehide', function () { forceRelease(); });
    win.addEventListener('pageshow', function (e) { if (e && e.persisted) forceRelease(); });
  }

  var ScrollLock = {
    lock: lock,
    unlock: unlock,
    forceRelease: forceRelease,
    ensureReleased: ensureReleased,
    isLocked: isLocked,
    // Exposed for tests only (same "export an internal for testability"
    // precedent as js/interpret-experience.js / js/purchase-sheet.js).
    _refCount: function () { return refCount; }
  };

  if (win) win.ScrollLock = ScrollLock;
  if (typeof module !== 'undefined' && module.exports) module.exports = ScrollLock;
})();
