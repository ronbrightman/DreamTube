// js/bottom-nav.js
//
// Shared renderer for Bar A, the anchored "night dock" bottom nav —
// tracker item for-product-urgent-founder-roll-the-new--8pyek3,
// founder verbatim: "The bottom nav bar is not the same across screens
// so make it like it is in the profile screen — in the homepage and in
// explore." This is now THE one shared renderer for every page with a
// bottom nav (home.html, explore.html, profile.html, result.html) —
// same markup, same CSS (.night-dock*, css/styles.css), same
// avatar-in-Profile-tab treatment everywhere.
//
// History: this module used to render the OLDER, separate `.bottom-nav`
// in-flow visual system shared only by home.html/explore.html, while
// profile.html had its own bespoke, newer `.night-dock` overlay bar
// (Bar A) hand-copied into that one page only — two competing systems by
// design at the time (tracker items g0m6ck / bb6224b). This item is the
// founder-decided reconciliation: retire the old `.bottom-nav` system
// entirely, and have every page render Bar A through this one module.
// result.html gets it for the first time here too — it previously had NO
// bottom nav at all, which stranded a first-time user with no way back
// to Home/Explore/Profile (tracker item
// for-product-hotfix-now-founder-urgent-re-w743iy).
//
// Tab order is Home / Explore / + / Profile everywhere -- founder-
// approved twice over (Ron, 2026-07-29: "Must add a way to get to
// homepage from profile and explore"; and his separate approval of the
// Bar A / night-dock mock, whose spec is this exact order). See
// g0m6ck's tracker comment thread for the full decision trail.
//
// Same self-contained-module pattern as js/purchase-sheet.js: plain
// script (no ES modules -- see CLAUDE.md), attaches window.BottomNav.
// Icons, the avatar-as-Profile-icon, and the new-likes badge are always
// identical on every page that uses this, so they're baked in here.
// Anything genuinely page-specific stays in that page's own inline
// script, wired against the stable ids this module renders
// (#nav-home/#nav-explore/#nav-create/#nav-profile) -- e.g. explore.html's
// logged-out signup-nudge gate on +Create/Home/Profile (it has no login
// gate of its own, unlike every other page). Rendering is synchronous
// plain innerHTML, so a caller's very next line can already
// getElementById() anything rendered here.
//
// Call mount() again any time the signed-in "Me" character's name/photo
// changes (see profile.html's renderIdentity()) -- it's cheap and
// idempotent, and is how the SAME identity source stays in sync between
// a page's own header and the dock's Profile tab in one call.

(function () {
  'use strict';

  /**
   * Minimal attribute-safe HTML escape -- kept local (not borrowed from
   * js/dream-cards.js's DreamCards.esc) so this module has no load-order
   * dependency on that file; not every page that needs a bottom nav also
   * loads dream-cards.js (e.g. explore.html, result.html).
   */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * The signed-in account's own "Me" character -- the SAME identity
   * source profile.html's own header reads/writes
   * (DreamStore.saveCharacter({isSelf:true, ...})), not a second copy.
   */
  function getMeCharacter() {
    if (typeof DreamStore === 'undefined' || !DreamStore.getCharacters) return null;
    return DreamStore.getCharacters().filter(function (c) { return c.isSelf; })[0] || null;
  }

  /**
   * Avatar-as-Profile-icon markup (the YouTube "You" treatment): the Me
   * character's photo if one exists, else the first letter of their
   * display name, never a placeholder glyph that would read as "not
   * signed in". Works logged-out too (explore.html) -- getCurrentUser()
   * is null there, displayName falls back to '', and '?' is used.
   */
  function avatarInnerHTML() {
    var user = (typeof DreamStore !== 'undefined' && DreamStore.getCurrentUser) ? DreamStore.getCurrentUser() : null;
    var me = getMeCharacter();
    var displayName = (me && me.name) ? me.name : (user ? DreamStore.displayHandle(user.handle) : '');
    if (me && me.photoDataUrl) {
      return '<img src="' + esc(me.photoDataUrl) + '" alt="">';
    }
    return esc((displayName || '?').trim().charAt(0).toUpperCase());
  }

  /**
   * @param {Element} container - filled with the night-dock markup.
   *   Pass the page's own `<nav class="night-dock" id="...">` element
   *   (see css/styles.css's `.night-dock` -- absolutely positioned,
   *   anchored to the bottom of #app, content scrolls/plays BEHIND it).
   * @param {Object} opts
   * @param {'home'|'explore'|'profile'} opts.active - which tab gets the
   *   `.active` class + `aria-current="page"`.
   * @param {boolean} [opts.shimmerHome] - when true, the Home tab gently
   *   shimmers to draw the eye back home (founder 2026-08-15: "when user is
   *   in profile page or Dream result page make the home icon shimmer a
   *   little bit"). Opt-in per page: only profile.html / result.html pass it
   *   — home.html (already on Home) and explore.html deliberately don't.
   */
  function mount(container, opts) {
    if (!container) return;
    opts = opts || {};
    var active = opts.active;

    function itemClass(tab) {
      return 'night-dock-item' + (tab === active ? ' active' : '');
    }
    function ariaCurrent(tab) {
      return tab === active ? ' aria-current="page"' : '';
    }

    container.innerHTML =
      '<a class="' + itemClass('home') + '" href="home.html" id="nav-home"' + ariaCurrent('home') + '>' +
        '<div class="nav-icon icon" id="dock-icon-home"></div><span class="night-dock-label">Home</span></a>' +
      '<a class="' + itemClass('explore') + '" href="explore.html" id="nav-explore"' + ariaCurrent('explore') + '>' +
        '<div class="nav-icon icon" id="dock-icon-explore"></div><span class="night-dock-label">Explore</span></a>' +
      '<a class="night-dock-create" href="create.html" id="nav-create" aria-label="Create">' +
        '<span class="icon" id="dock-icon-create"></span></a>' +
      '<a class="' + itemClass('profile') + '" href="profile.html" id="nav-profile"' + ariaCurrent('profile') + '>' +
        // The avatar is aria-hidden: it's a decorative stand-in for the
        // tab icon, and the label already names the destination --
        // without this a screen reader would announce the account's
        // initial as part of the tab name.
        '<div class="nav-icon-badge-wrap" aria-hidden="true"><i class="night-dock-avatar" id="dock-avatar">' + avatarInnerHTML() + '</i>' +
        '<span class="nav-badge-dot" id="nav-profile-badge" hidden></span></div><span class="night-dock-label">Profile</span>' +
      '</a>';

    // Inactive tabs draw LINE glyphs; whichever tab is active draws
    // filled (or, for Profile, the avatar rather than a glyph at all --
    // see avatarInnerHTML() above). Icons.compass is already a line
    // glyph; Icons.home is filled, so Icons.homeOutline is its
    // line-variant pair for whichever page isn't Home.
    // Scoped to THIS container, not getElementById (bug, founder screenshot
    // 2026-08-07): the Chamber's persona picker mounts a SECOND dock on a
    // page that already has one, and document-global id lookups always hit
    // the FIRST dock — leaving the overlay's copy with empty icon slots
    // (blank + button, label-only tabs). Every dock now fills its own
    // elements regardless of how many are mounted.
    container.querySelector('#dock-icon-home').innerHTML = (active === 'home') ? Icons.home : Icons.homeOutline;
    container.querySelector('#dock-icon-explore').innerHTML = Icons.compass;
    container.querySelector('#dock-icon-create').innerHTML = Icons.plus;

    // Opt-in Home-tab shimmer (see opts.shimmerHome above) -- a gentle,
    // reduced-motion-aware pulse defined in css/styles.css (.shimmer-home).
    // Scoped to THIS container's own Home item, same as the icon fills above.
    if (opts.shimmerHome) {
      var homeItem = container.querySelector('#nav-home');
      if (homeItem) homeItem.classList.add('shimmer-home');
    }

    // New-likes badge dot (tracker item idea-notify-likes) -- the same
    // synchronous, no-network read every bottom-nav page has always done.
    // See js/store.js's getCachedNewLikesCount doc block for why this
    // never fetches anything itself.
    container.querySelector('#nav-profile-badge').hidden =
      !(typeof DreamStore !== 'undefined' && DreamStore.getCachedNewLikesCount() > 0);
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
