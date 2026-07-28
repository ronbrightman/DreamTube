// test/helpers/touch-drag.js
//
// Simulates a real vertical touch drag against a page element for
// Playwright-driven tests of js/sheet-dismiss.js (tracker item
// for-product-sheet-dismissal-app-wide-fix-rlay70). Playwright's public
// `page.touchscreen` API only offers `tap()`, no swipe/drag primitive, so
// this dispatches synthetic touchstart/touchmove*/touchend DOM events
// directly against the element via page.evaluate — sheet-dismiss.js's
// drag logic only ever listens for plain DOM TouchEvents (no native
// browser gesture/scroll-machinery dependency), so this reaches the
// exact same code path a real finger drag would, from a bare desktop
// Chromium context (needs `hasTouch: true` on the browser context for
// the `Touch`/`TouchEvent` constructors used below to exist at all).
//
// A single touchstart+touchmove (2 points) is NOT enough to exercise a
// real drag: sheet-dismiss.js's onTouchMove resets its internal
// drag-start baseline to the CURRENT point on the exact touchmove event
// that commits to dragging (so the very first tracked frame reads a
// zero offset, matching how a real drag begins at zero displacement) --
// multiple intermediate touchmove points are required for the tracked
// offset to ever become nonzero. `steps` below defaults generously past
// that minimum.

/**
 * dragSheet(page, selector, opts) — drags the element matching `selector`
 * vertically from its current position down (or up) by `opts.deltaY`
 * pixels, over `opts.steps` intermediate touchmove events (default 20)
 * spaced `opts.stepDelayMs` apart (default 16ms, one 60fps frame).
 * `opts.startY` overrides the drag's starting clientY (defaults to the
 * element's own vertical center) -- useful for starting a drag from a
 * specific point (e.g. the visible grab handle) rather than wherever
 * the element's midpoint happens to be for a very tall sheet.
 */
function dragSheet(page, selector, opts) {
  opts = opts || {};
  var deltaY = typeof opts.deltaY === 'number' ? opts.deltaY : 0;
  var steps = typeof opts.steps === 'number' ? opts.steps : 20;
  var stepDelayMs = typeof opts.stepDelayMs === 'number' ? opts.stepDelayMs : 16;
  var startY = opts.startY;

  return page.evaluate(function (args) {
    return new Promise(function (resolve) {
      var el = document.querySelector(args.selector);
      if (!el) { resolve(); return; }
      var rect = el.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var fromY = typeof args.startY === 'number' ? args.startY : (rect.top + rect.height / 2);
      var toY = fromY + args.deltaY;

      function fire(type, y) {
        var touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        var ev = new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true
        });
        el.dispatchEvent(ev);
      }

      var points = [];
      for (var i = 0; i <= args.steps; i++) {
        points.push(fromY + (toY - fromY) * (i / args.steps));
      }

      var idx = 0;
      function step() {
        if (idx >= points.length) { resolve(); return; }
        var type = idx === 0 ? 'touchstart' : (idx === points.length - 1 ? 'touchend' : 'touchmove');
        fire(type, points[idx]);
        idx++;
        setTimeout(step, args.stepDelayMs);
      }
      step();
    });
  }, { selector: selector, deltaY: deltaY, steps: steps, stepDelayMs: stepDelayMs, startY: startY });
}

module.exports = { dragSheet: dragSheet };
