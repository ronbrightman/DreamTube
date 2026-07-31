// js/bottom-nav.js
//
// Shared renderer for the OLD .bottom-nav visual system that home.html
// and explore.html still use -- tracker item
// for-product-bug-design-pass-find-bottom--g0m6ck. Factored out because
// three hand-copied navs (home.html/explore.html/profile.html) had
// already drifted out of sync once (home.html shipped Home/+/Explore/
// Profile while profile.html/explore.html shipped Home/Explore/+/
// Profile -- the same DOM order flex `space-around` renders as visual
// order, so the + button visibly jumped position when tabbing between
// Home and Explore). One renderer means that class of drift can't
// recur for these two pages again.
//
// Tab order is Home / Explore / + / Profile everywhere -- founder-
// approved twice over (Ron, 2026-07-29: "Must add a way to get to
// homepage from profile and explore"; and his separate approval of the
// Bar A / night-dock mock, whose spec is this exact order). See this
// tracker item's own comment thread for the full decision trail.
//
// Deliberately does NOT touch profile.html's `.night-dock` system --
// that's a separate, newer, founder-approved visual language (Bar A),
// explicitly scoped to that page only by its own commit's header
// comment. This module is for the old-style `.bottom-nav` pages only.
// Unifying the old-style pages onto the new night-dock visual language
// is a real, undecided restyle question -- out of scope here.
//
// Same self-contained-module pattern as js/purchase-sheet.js: plain
// script (no ES modules -- see CLAUDE.md), attaches window.BottomNav.
// Icons and the new-likes badge are always identical on every page that
// uses this, so they're baked in here. Anything genuinely page-specific
// stays in that page's own inline script, wired against the stable ids
// this module renders (#nav-home/#nav-explore/#nav-create/#nav-profile)
// -- e.g. explore.html's logged-out signup-nudge gate on +Create/
// Profile (it has no login gate of its own, unlike every other page),
// or home.html's own top-of-script login redirect. Rendering is
// synchronous plain innerHTML (same as purchase-sheet.js's
// mountBalanceChip), so a caller's very next line can already
// getElementById() anything rendered here.

(function () {
  'use strict';

  /**
   * @param {Element} container - emptied and filled with the nav markup.
   *   Pass the page's existing `.bottom-nav` element itself so its
   *   existing CSS/layout (position:sticky, safe-area padding, etc. --
   *   see css/styles.css) applies unchanged.
   * @param {Object} opts
   * @param {'home'|'explore'|'profile'} opts.active - which tab gets the
   *   `.active` class + `aria-current="page"`.
   */
  function mount(container, opts) {
    if (!container) return;
    opts = opts || {};
    var active = opts.active;

    function itemClass(tab) {
      return 'nav-item' + (tab === active ? ' active' : '');
    }
    function ariaCurrent(tab) {
      return tab === active ? ' aria-current="page"' : '';
    }

    container.innerHTML =
      '<a class="' + itemClass('home') + '" href="home.html" id="nav-home"' + ariaCurrent('home') + '>' +
        '<div class="nav-icon icon" id="nav-icon-home"></div>Home</a>' +
      '<a class="' + itemClass('explore') + '" href="explore.html" id="nav-explore"' + ariaCurrent('explore') + '>' +
        '<div class="nav-icon icon" id="nav-icon-explore"></div>Explore</a>' +
      '<a class="nav-create" href="create.html" id="nav-create" title="Turn Your Dream Into a Video">+</a>' +
      '<a class="' + itemClass('profile') + '" href="profile.html" id="nav-profile"' + ariaCurrent('profile') + '>' +
        '<div class="nav-icon-badge-wrap"><div class="nav-icon icon" id="nav-icon-profile"></div>' +
        '<span class="nav-badge-dot" id="nav-profile-badge" hidden></span></div>Profile</a>';

    document.getElementById('nav-icon-home').innerHTML = Icons.home;
    document.getElementById('nav-icon-explore').innerHTML = Icons.compass;
    document.getElementById('nav-icon-profile').innerHTML = Icons.person;

    // New-likes badge dot (tracker item idea-notify-likes) -- the same
    // synchronous, no-network read every bottom-nav page has always done.
    // See js/store.js's getCachedNewLikesCount doc block for why this
    // never fetches anything itself.
    document.getElementById('nav-profile-badge').hidden =
      !(DreamStore.getCachedNewLikesCount() > 0);
  }

  var BottomNav = {
    mount: mount
  };

  // Browser: attach to window, same as every other js/*.js file in this
  // codebase. Node/test environment (no `window` global): export via
  // module.exports too, same dual-target pattern as js/purchase-sheet.js.
  if (typeof window !== 'undefined') window.BottomNav = BottomNav;
  if (typeof module !== 'undefined' && module.exports) module.exports = BottomNav;
})();
