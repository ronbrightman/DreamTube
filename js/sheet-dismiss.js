// js/sheet-dismiss.js
//
// Shared bottom-sheet dismissal behavior — tracker item
// for-product-sheet-dismissal-app-wide-fix-rlay70 (founder re-request,
// first logged on settings-sheet-profile-html-review-swipe-igw84s, never
// built until now). Founder's own words: the interpretation sheet
// (result.html) and the settings sheet (profile.html) "cannot be closed
// except by scrolling all the way down to a Close button — the
// grab-handle line at the top does nothing, and tapping the area above
// the sheet does nothing either."
//
// Root causes fixed here, once, for every .sheet-overlay in the app
// (this codebase has a standing rule against fixing the same bug shape
// twice in different places — see FOUNDER_PRINCIPLES.md):
//
//  1. Drag-to-dismiss was NOT implemented anywhere — every .sheet-handle
//     was purely decorative, no touch handlers at all. Implemented below
//     with plain touchstart/touchmove/touchend (no library — this is a
//     static multi-module-less site, see CLAUDE.md).
//
//  2. Tap-outside-to-close existed, but as N separate hand-written
//     `overlay.addEventListener('click', function(e){ if (e.target ===
//     overlay) close(); })` copies scattered across result.html,
//     profile.html, create.html, wizard.html, start.html, and
//     js/purchase-sheet.js. Centralized into wire() below so every sheet
//     gets the identical behavior from one place, and so the drag gesture
//     (which has real edge cases — see (3) below) only has to be gotten
//     right once.
//
//  3. css/styles.css's `.sheet` already caps max-height at 88vh (added
//     2026-07-18, commit 7e744ee), which in principle leaves a tappable
//     backdrop strip above every sheet regardless of content length —
//     but that rule used plain `vh`, while `#app` (the sheet's own
//     positioning ancestor) sizes itself with `dvh` (dynamic viewport
//     height, i.e. the CURRENTLY visible viewport once the browser
//     chrome/address-bar is accounted for). On a real phone with the
//     address bar expanded, static `vh` is measured against the LARGER
//     chrome-collapsed viewport, so 88vh can be MORE than 88% of `#app`'s
//     actual current on-screen height — the sheet can end up covering
//     nearly all of the visible viewport with zero practically-tappable
//     backdrop above it, exactly matching the founder's real-device
//     report, even though headless/desktop testing (where vh and dvh
//     coincide) never shows the problem. Fixed alongside this file by
//     switching that rule to `88dvh` (see css/styles.css) so the sheet's
//     cap tracks the SAME viewport #app itself is sized against.
//
// wire() deliberately takes the caller's own close function rather than
// mutating DOM classes itself — every page's real close function
// (closeSheet('interp'), closeCharSheet(), PurchaseSheet.hide(), etc.)
// already does its own per-instance-token bumping / onDismiss callbacks /
// state cleanup (this codebase's documented recurring
// stale-async-callback pattern — see tracker.html's
// recurring-stale-async-callback-bug-shape-xp61pn), and every dismissal
// path (Close button, tap-outside, drag) must run through that exact
// same function so none of those existing guards get bypassed.
(function () {
  'use strict';

  // How far (as a fraction of the sheet's own rendered height) a drag
  // must travel down before it counts as an intentional dismiss rather
  // than a re-settle. Matches standard iOS bottom-sheet behavior.
  var DISMISS_RATIO = 0.3;

  // A downward flick faster than this (px/ms) dismisses regardless of
  // how far it's travelled yet — lets a quick flick from anywhere near
  // the top feel instant rather than requiring the full 30% distance.
  var VELOCITY_THRESHOLD = 0.6;

  // Matches css/styles.css's `.sheet{ transition:transform .3s
  // cubic-bezier(...) }` — used as the fallback timer for the
  // drag-driven close/snap-back animations, in case a transitionend
  // event is ever missed (e.g. the element gets hidden by other code
  // mid-transition).
  var TRANSITION_FALLBACK_MS = 350;

  /**
   * Wires tap-outside-to-close and touch drag-to-dismiss onto a single
   * .sheet-overlay/.sheet pair.
   *
   * overlayEl — the .sheet-overlay element (the tap-outside target and
   *             the element whose descendant .sheet is dragged).
   * onDismiss — zero-arg function that performs the page's own real
   *             close (removes .open, runs whatever per-page cleanup /
   *             instance-token bump / onDismiss callback that page's
   *             close function already does). Called exactly once per
   *             dismissal, same as a manual Close-button click already
   *             would.
   * opts.sheetEl — optional; defaults to overlayEl.querySelector('.sheet').
   *                Only needed if an overlay ever contains more than one
   *                .sheet child (none do today).
   */
  function wire(overlayEl, onDismiss, opts) {
    if (!overlayEl || typeof onDismiss !== 'function') return;
    opts = opts || {};
    var sheetEl = opts.sheetEl || overlayEl.querySelector('.sheet');

    // ---- Tap outside the sheet (on the backdrop itself) closes it. ----
    // Only fires when the click TARGET is the overlay element itself —
    // any click that bubbles up from inside .sheet has e.target set to
    // whatever was actually tapped inside it, never the overlay.
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) onDismiss();
    });

    if (!sheetEl) return; // nothing to drag — tap-outside above still works

    // ---- Drag-to-dismiss ----
    var dragging = false;   // true once this gesture has committed to dragging the sheet
    var deciding = false;    // true from touchstart until the first touchmove decides drag vs scroll
    var dragStartY = 0;      // the Y a drag's 1:1 tracking is measured from (reset at the moment a gesture commits to dragging, not at touchstart, so there's no jump when a scroll-then-drag gesture converts)
    var lastY = 0;
    var lastT = 0;
    var velocity = 0;        // px/ms, signed (positive = moving down), from the most recent touchmove
    var sheetHeight = 0;
    var settling = false;    // a close/snap-back transition is already in flight — ignore new touches until it finishes

    function onTouchStart(e) {
      if (settling || e.touches.length !== 1) return;
      deciding = true;
      dragging = false;
      var y = e.touches[0].clientY;
      dragStartY = y;
      lastY = y;
      lastT = Date.now();
      velocity = 0;
    }

    function onTouchMove(e) {
      if (!deciding || e.touches.length !== 1) return;
      var y = e.touches[0].clientY;

      if (!dragging) {
        // Only commit to a drag once the sheet's own content is
        // scrolled fully to the top AND the finger is already moving
        // downward — otherwise this is an ordinary scroll gesture and
        // must be left alone (rule c: drag and internal scroll must
        // never fight each other).
        if (sheetEl.scrollTop > 0 || y <= dragStartY) {
          lastY = y;
          lastT = Date.now();
          return;
        }
        dragging = true;
        dragStartY = y; // 1:1 tracking begins from the moment of commit, not the original touchstart point
        sheetHeight = sheetEl.getBoundingClientRect().height || 1;
        sheetEl.style.transition = 'none';
      }

      if (e.cancelable) e.preventDefault();
      var offset = Math.max(0, y - dragStartY);
      var now = Date.now();
      var dt = now - lastT;
      if (dt > 0) velocity = (y - lastY) / dt;
      lastY = y;
      lastT = now;
      sheetEl.style.transform = 'translateY(' + offset + 'px)';
    }

    function onTouchEnd() {
      deciding = false;
      if (!dragging) return;
      dragging = false;

      var offset = Math.max(0, lastY - dragStartY);
      var shouldDismiss = offset > sheetHeight * DISMISS_RATIO || velocity > VELOCITY_THRESHOLD;

      // Re-enable the sheet's normal CSS transition (disabled above for
      // 1:1 drag tracking) so both the dismiss slide-out and the
      // snap-back below animate smoothly, matching every other
      // open/close of this sheet.
      sheetEl.style.transition = '';
      settling = true;

      function finishSettle(runDismiss) {
        return function () {
          if (!settling) return; // already handled by the other of transitionend/fallback-timer
          settling = false;
          sheetEl.removeEventListener('transitionend', onTransitionEnd);
          clearTimeout(fallbackTimer);
          if (runDismiss) {
            // Let the page's real close function run FIRST — it removes
            // the overlay's .open class, which flips .sheet's own
            // (non-.open) CSS rule to transform:translateY(100%),
            // exactly matching the inline value we just animated to.
            // Only after that do we clear the inline override, so there
            // is no visible snap-back flash in between.
            onDismiss();
          }
          sheetEl.style.transform = '';
        };
      }

      var onTransitionEnd, fallbackTimer;
      if (shouldDismiss) {
        sheetEl.style.transform = 'translateY(100%)';
        onTransitionEnd = finishSettle(true);
      } else {
        sheetEl.style.transform = 'translateY(0px)';
        onTransitionEnd = finishSettle(false);
      }
      sheetEl.addEventListener('transitionend', onTransitionEnd);
      fallbackTimer = setTimeout(onTransitionEnd, TRANSITION_FALLBACK_MS);
    }

    sheetEl.addEventListener('touchstart', onTouchStart, { passive: true });
    sheetEl.addEventListener('touchmove', onTouchMove, { passive: false });
    sheetEl.addEventListener('touchend', onTouchEnd, { passive: true });
    sheetEl.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  var SheetDismiss = { wire: wire };

  if (typeof window !== 'undefined') window.SheetDismiss = SheetDismiss;
  if (typeof module !== 'undefined' && module.exports) module.exports = SheetDismiss;
})();
