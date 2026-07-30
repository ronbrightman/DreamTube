// js/bottom-nav.js
//
// Shared bottom tab bar — tracker item
// for-product-bug-design-pass-find-bottom--g0m6ck. Factored out of
// home.html/profile.html/explore.html, which each used to hand-copy this
// markup independently. That drifted: home.html rendered
// Home / +Create / Explore / Profile while profile.html and explore.html
// both rendered Home / Explore / +Create / Profile — since .bottom-nav is
// flex `space-around` (see css/styles.css), DOM order IS visual order, so
// the center "+" button physically jumped position depending on which of
// those two orders the current page happened to use. Grepped the whole
// repo for ".bottom-nav" to confirm exactly these 3 pages render it (no
// 4th hand-copied instance found).
//
// Canonical order (profile.html/explore.html's shared order — the one
// home.html had drifted away from): Home / Explore / +Create / Profile.
//
// Plain script (no ES modules — matches every other file in this
// codebase, see CLAUDE.md), attaches window.BottomNav. Same
// self-contained "renders itself into a mount point" shape as
// js/purchase-sheet.js, minus that file's sheet-overlay/analytics
// machinery, which the bottom nav has no equivalent of.
//
// Usage (identical on every page):
//   <div class="bottom-nav" id="bottom-nav-mount"></div>
//   ...
//   <script src="js/icons.js"></script>
//   <script src="js/store.js"></script>
//   <script src="js/bottom-nav.js"></script>
//   <script>
//     BottomNav.mount('bottom-nav-mount', { active: 'home' });
//   </script>
//
// The mount element must already carry class="bottom-nav" (css/styles.css
// styles that class, not an id) — mount() only replaces its innerHTML with
// the tab markup, same "page keeps the container, module fills it in"
// division of responsibility purchase-sheet.js uses for its own overlay.
//
// Per-page differences this intentionally does NOT try to unify (each
// page's own inline script still owns these, same as before):
//   - profile.html fetches the real new-likes total (refreshNewLikesCount)
//     and updates #nav-profile-badge/#new-likes-banner together once that
//     resolves — mount() only seeds the badge's INITIAL state from the
//     synchronous cached count, same as home.html/explore.html always
//     did, before that fetch (profile.html-only) overwrites it.
//   - explore.html is the one page with no login gate of its own, so it
//     alone intercepts taps on #nav-create/#nav-profile with a signup
//     nudge modal (see explore.html's own gateNavLink) instead of letting
//     the tap through to a page that would just bounce to a bare login
//     screen. mount() always renders those two anchors with the
//     ids gateNavLink needs (#nav-create/#nav-profile were already both
//     present on every page before this refactor); explore.html's own
//     script still wires the click-gating itself, after calling mount().

(function () {
  'use strict';

  // data-nav marks which tab gets .active for a given page; the "+" button
  // is deliberately never active (matches every page's pre-existing markup).
  var NAV_HTML =
    '<a class="nav-item" data-nav="home" href="home.html"><div class="nav-icon icon"></div>Home</a>' +
    '<a class="nav-item" data-nav="explore" href="explore.html"><div class="nav-icon icon"></div>Explore</a>' +
    '<a class="nav-create" id="nav-create" href="create.html" title="Turn Your Dream Into a Video">+</a>' +
    '<a class="nav-item" data-nav="profile" href="profile.html" id="nav-profile"><div class="nav-icon-badge-wrap"><div class="nav-icon icon"></div><span class="nav-badge-dot" id="nav-profile-badge" hidden></span></div>Profile</a>';

  /**
   * Renders the shared bottom nav into `target` (an element, or an id
   * string resolved via getElementById).
   *
   * opts:
   *   active — 'home' | 'explore' | 'profile', which tab gets the
   *            .nav-item.active styling for the current page.
   *
   * Returns the mounted container element, or null if `target` couldn't
   * be resolved.
   */
  function mount(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return null;

    el.innerHTML = NAV_HTML;

    if (opts.active) {
      var activeEl = el.querySelector('[data-nav="' + opts.active + '"]');
      if (activeEl) activeEl.classList.add('active');
    }

    // Icon fill-in — every page used to do this itself (either by specific
    // ids, or positionally via querySelectorAll('.nav-icon'), which is what
    // this mirrors) once js/icons.js's Icons global was available.
    if (typeof window.Icons !== 'undefined') {
      var icons = el.querySelectorAll('.nav-icon');
      if (icons[0]) icons[0].innerHTML = Icons.home;
      if (icons[1]) icons[1].innerHTML = Icons.compass;
      if (icons[2]) icons[2].innerHTML = Icons.person;
    }

    // New-likes badge dot (tracker item idea-notify-likes) — seed its
    // initial visibility from the synchronous, no-network cached count,
    // same as home.html/explore.html always did. profile.html's own
    // page-load fetch (DreamStore.refreshNewLikesCount) still overwrites
    // this once it resolves, same as before this refactor.
    if (window.DreamStore && typeof DreamStore.getCachedNewLikesCount === 'function') {
      var badge = document.getElementById('nav-profile-badge');
      if (badge) badge.hidden = !(DreamStore.getCachedNewLikesCount() > 0);
    }

    return el;
  }

  var BottomNav = { mount: mount };

  // Browser: attach to window, same as every other js/*.js file in this
  // codebase. Node/test environment (no `window` global): export via
  // module.exports too, same dual-target pattern as js/purchase-sheet.js.
  if (typeof window !== 'undefined') window.BottomNav = BottomNav;
  if (typeof module !== 'undefined' && module.exports) module.exports = BottomNav;
})();
