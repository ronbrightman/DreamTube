// js/dream-cards.js
//
// Shared renderer for the "library" dream tiles — the 9:14 grid cards
// profile.html shows for the signed-in account's own dreams, plus the
// dimmer "upcoming night" placeholder slots that sit alongside them.
//
// Tracker item for-product-build-founder-approved-2026--to6ew2 (Part 5,
// "shared js/dream-cards.js factoring"). Before this file, profile.html
// hand-rolled its tile markup inline — the same duplicate-markup drift
// class of bug the bottom-nav item (for-product-bug-design-pass-find-
// bottom--g0m6ck) hit for a THIRD time. Factored out here, following the
// exact self-contained-renderer pattern js/purchase-sheet.js already
// establishes in this codebase: a plain script (no ES modules — see
// CLAUDE.md), attaching window.DreamCards, with the pure (no-DOM) helpers
// dual-exported via module.exports so test/*.test.js can require() this
// file directly under node --test.
//
// SCOPE NOTE: only profile.html consumes this today, deliberately.
// explore.html renders a full-bleed swipeable video FEED (.feed-card),
// not a grid tile, and home.html's "My dreams" strip renders 56px-high
// thumbs — neither is the same component, so neither was force-fitted
// into this module. The class names emitted here (.vcard*) are the ones
// css/styles.css already carries, so the shared base styling travels with
// the markup; a night-themed consumer skins them page-scoped (see
// profile.html's own <style> block, same convention home.html uses).
//
// ============================================================================
// THE "UPCOMING NIGHTS" PLACEHOLDER SLOTS — READ-ONLY, BY DESIGN
// ----------------------------------------------------------------------------
// Founder amendment on the same tracker item: empty library slots stay as
// DIMMER placeholder squares, and the streak/journey "shows through" them
// so an empty tile reads as a next step ("Night 3 · tomorrow" in the
// dimmest text tier, the first empty slot slightly brighter as "next").
//
// This is a MIRROR of home.html's dream-log state, never a second claim
// surface. Nothing in this file grants, claims, or writes anything — it
// takes an already-computed dream count + "did they log today" flag and
// returns labels. Home is the sole ritual/claim owner (see profile.html's
// own token-chip comment and lib/entitlements.js's daily-claim doc block).
// ============================================================================

(function () {
  'use strict';

  var DAY_MS = 86400000;

  // ==========================================================================
  // Pure helpers (no DOM) — dual-exported for node --test.
  // ==========================================================================

  /**
   * HTML-escapes a string for interpolation into markup. Deliberately
   * stricter than profile.html's old DOM-based esc() (a detached div's
   * innerHTML round-trip, which leaves " and ' untouched): this one is
   * also safe inside a quoted attribute, and works with no DOM at all so
   * the markup builders below stay unit-testable under node --test.
   */
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** "999" / "1k" / "1.2k" — same shape profile.html's own formatCount had before this module existed. */
  function formatCount(n) {
    var v = typeof n === 'number' && isFinite(n) ? n : 0;
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return String(v);
  }

  /**
   * "today" / "yesterday" / "3 days ago" / "2 weeks ago" / "1 month ago"
   * from an epoch-ms createdAt — calendar-day based (midnight-to-midnight),
   * not a raw hour count, so a dream saved at 23:50 reads "yesterday" the
   * next morning rather than "today".
   *
   * Returns '' for a dream saved before the createdAt field existed (see
   * js/store.js's finalizeDream doc comment) — same "missing means don't
   * show it, never fabricate" rule the rest of this codebase follows,
   * rather than rendering a wrong date.
   */
  function relativeDayLabel(createdAt, nowMs) {
    if (typeof createdAt !== 'number' || !isFinite(createdAt)) return '';
    var then = new Date(createdAt); then.setHours(0, 0, 0, 0);
    var now = new Date(typeof nowMs === 'number' ? nowMs : Date.now()); now.setHours(0, 0, 0, 0);
    var days = Math.round((now.getTime() - then.getTime()) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days ago';
    var weeks = Math.floor(days / 7);
    if (weeks === 1) return '1 week ago';
    if (weeks < 5) return weeks + ' weeks ago';
    var months = Math.floor(days / 30);
    return months <= 1 ? '1 month ago' : months + ' months ago';
  }

  /**
   * The journey labels behind the placeholder slots — pure, so the
   * numbering/dating rules are testable without a browser.
   *
   * opts:
   *   dreamCount  — how many dreams this account already has (the tiles
   *                  actually rendered above the placeholders). The first
   *                  placeholder is therefore night `dreamCount + 1`.
   *   loggedToday — DreamStore.getDreamLogStatus().loggedToday. If tonight
   *                  is already covered, the first upcoming slot is
   *                  "tomorrow"; if not, it's "tonight" — this is the
   *                  entire sense in which Home's state "shows through"
   *                  these tiles.
   *   count       — how many placeholders to produce (default 2 — one grid
   *                  row's worth; deliberately small, per the founder's
   *                  "keep it tasteful").
   *
   * Returns [{ night, when, isNext }] — `isNext` true for the first slot
   * only (rendered slightly brighter; see slotHTML below).
   */
  function upcomingSlots(opts) {
    opts = opts || {};
    var count = typeof opts.count === 'number' ? opts.count : 2;
    var dreamCount = typeof opts.dreamCount === 'number' && opts.dreamCount > 0 ? opts.dreamCount : 0;
    var loggedToday = !!opts.loggedToday;
    var slots = [];
    for (var i = 0; i < count; i++) {
      // Tonight is only "available" as the next step when it hasn't
      // already been logged — otherwise every slot shifts a day later.
      var dayOffset = loggedToday ? i + 1 : i;
      slots.push({
        night: dreamCount + 1 + i,
        when: dayOffset === 0 ? 'tonight' : (dayOffset === 1 ? 'tomorrow' : 'in ' + dayOffset + ' days'),
        isNext: i === 0
      });
    }
    return slots;
  }

  // ==========================================================================
  // Markup builders — string-returning (no DOM APIs), so they're testable
  // under node --test too, and so a caller can build a whole grid with one
  // innerHTML assignment the way profile.html already did.
  // ==========================================================================

  /**
   * One real dream tile.
   *
   * opts:
   *   gradient — the CSS background for the no-media fallback. Callers in
   *              the browser pass DreamStore.gradientFor(d); tests can pass
   *              anything, which is why it's a parameter rather than a
   *              hard reference to the DreamStore global from in here.
   *   now      — epoch ms for relativeDayLabel (tests pin it; the app omits it).
   *
   * Media is three-way — video -> image -> gradient fallback (see
   * docs/IMAGE_GENERATION_SPEC.md §4). No autoplay attribute: playback is
   * driven by observeVideos() below, which is what actually renders a
   * visible preview frame — preload="metadata" alone does not guarantee a
   * decoded frame (same root cause home.html's own thumb observer fixes).
   */
  function tileHTML(d, opts) {
    opts = opts || {};
    var gradient = opts.gradient || '';
    var media = d.videoUrl
      ? '<video class="vcard-video" src="' + esc(d.videoUrl) + '" muted loop playsinline preload="metadata"></video>'
      : d.imageUrl
        ? '<img class="vcard-image" src="' + esc(d.imageUrl) + '" alt="">'
        : '<div class="vcard-thumb-bg" style="background:' + gradient + '"></div>';
    var when = relativeDayLabel(d.createdAt, opts.now);
    var likes = typeof d.likes === 'number' ? d.likes : 0;
    // Meta reads as the mock does — the tile's own age leads. The like
    // count is appended only when there genuinely is one, rather than
    // padding every tile with "0 likes"; the owner's own handle (what this
    // line used to show) is redundant on their own profile.
    var metaParts = [];
    if (when) metaParts.push(when);
    if (likes > 0) metaParts.push(formatCount(likes) + ' like' + (likes === 1 ? '' : 's'));
    return '<a class="vcard" href="result.html?id=' + esc(d.id) + '">' +
      '<div class="vcard-thumb">' + media +
        '<div class="priv' + (d.isPublished ? ' pub' : '') + '">' + (d.isPublished ? 'Public' : 'Private') + '</div>' +
        '<div class="play-indicator icon">' + (opts.playIcon || '') + '</div>' +
        (d.dur ? '<div class="dur">' + esc(d.dur) + '</div>' : '') +
      '</div>' +
      '<div class="vcard-title" dir="auto">' + esc(d.caption) + '</div>' +
      (metaParts.length ? '<div class="vcard-meta">' + esc(metaParts.join(' · ')) + '</div>' : '') +
    '</a>';
  }

  /**
   * One dimmer placeholder square for an upcoming night (founder
   * amendment — see this file's header). Purely presentational: not a
   * link, not a button, no handler anywhere in this module. Tapping it
   * does nothing, which is the point — Home owns every entry action.
   */
  function slotHTML(slot) {
    // The empty square itself is decoration (aria-hidden) — but the label
    // is real journey information ("Night 3 · tomorrow"), so it stays in
    // the accessibility tree rather than the whole tile being hidden.
    return '<div class="vcard-slot' + (slot.isNext ? ' is-next' : '') + '">' +
      '<div class="vcard-slot-thumb" aria-hidden="true"><span class="vcard-slot-mark">+</span></div>' +
      '<div class="vcard-slot-label">Night ' + slot.night + ' · ' + esc(slot.when) + '</div>' +
    '</div>';
  }

  /** Convenience: the whole upcoming-nights run as one markup string. */
  function slotsHTML(opts) {
    return upcomingSlots(opts).map(slotHTML).join('');
  }

  /**
   * One tile for the horizontal "dream row" strip — home.html's My Dreams
   * scroll-snap row (tracker item for-product-build-ship-founder-go-07-31--
   * vtsyg3, home-mock4-x7q4.html's .dthumb). Deliberately NOT the same
   * component as tileHTML above (that's the vertical 9:14 profile.html
   * library grid, with caption/meta/privacy badge) — this is a small, wide,
   * media-only thumbnail with no text overlay at all.
   *
   * Factored here now, ahead of any second consumer, per the founder's own
   * verdict on the separate (non-blocking) tracker item
   * for-product-chamber-dream-linkage-is-unc-00s2dr (2026-07-31 evening):
   * the Chamber's own dream-picker is meant to reuse this exact row
   * component — "factor into js/dream-cards.js if not yet done, per the
   * standing shared-renderer discipline." Home.html is the only real
   * consumer today; the `selected`/`asButton` options below exist so that
   * future picker can opt into a non-navigating, ring-highlighted variant
   * without a second markup builder or a rewrite of this one.
   *
   * opts:
   *   gradient — CSS background for the no-media fallback (caller passes
   *              DreamStore.gradientFor(d), same convention as tileHTML).
   *   selected — true adds an `is-selected` class (a future picker's own
   *              visible ring) — home.html never sets this today.
   *   asButton — true renders a <button type="button"> (for a future
   *              picker that selects in place rather than navigating)
   *              instead of the default <a href="result.html?id=...">.
   *
   * The video element still uses the `.vcard-video` class (not a new
   * name) so the existing observeVideos() below picks it up automatically
   * — one observer, one convention, whichever component is on the page.
   */
  function dreamRowTileHTML(d, opts) {
    opts = opts || {};
    var gradient = opts.gradient || '';
    var media = d.videoUrl
      ? '<video class="vcard-video" src="' + esc(d.videoUrl) + '" muted loop playsinline preload="metadata"></video>'
      : d.imageUrl
        ? '<img class="vcard-image" src="' + esc(d.imageUrl) + '" alt="">'
        : '<div class="vcard-thumb-bg" style="background:' + gradient + '"></div>';
    var cls = 'dream-row-tile' + (opts.selected ? ' is-selected' : '');
    var idAttr = ' data-dream-id="' + esc(d.id) + '"';
    if (opts.asButton) {
      return '<button type="button" class="' + cls + '"' + idAttr + '>' + media + '</button>';
    }
    return '<a class="' + cls + '" href="result.html?id=' + esc(d.id) + '"' + idAttr + '>' + media + '</a>';
  }

  // ==========================================================================
  // Browser-only: the grid's video-preview observer.
  // ==========================================================================

  var observer = null;

  /**
   * Plays a muted preview of whichever grid thumbnails are actually on
   * screen (several can be visible at once, unlike Explore's one-at-a-time
   * swipe feed) and pauses the rest — both fixes the blank-thumbnail issue
   * and avoids every thumbnail decoding at once regardless of visibility.
   * Call after every re-render; it disconnects and re-observes, so it is
   * safe to call repeatedly and never accumulates stale observations.
   */
  function observeVideos() {
    if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var video = entry.target;
          if (entry.isIntersecting) {
            if (video.paused) video.play().catch(function () { /* autoplay can be blocked before any user gesture — muted should normally allow it regardless */ });
          } else {
            video.pause();
          }
        });
      }, { threshold: 0.2 });
    }
    observer.disconnect();
    Array.prototype.forEach.call(document.querySelectorAll('.vcard-video'), function (v) { observer.observe(v); });
  }

  // formatCount stays internal (tileHTML is its only caller) rather than
  // being exported for no consumer — same "no dead surface" discipline the
  // rest of this codebase follows.
  var DreamCards = {
    esc: esc,
    relativeDayLabel: relativeDayLabel,
    upcomingSlots: upcomingSlots,
    tileHTML: tileHTML,
    slotHTML: slotHTML,
    slotsHTML: slotsHTML,
    dreamRowTileHTML: dreamRowTileHTML,
    observeVideos: observeVideos
  };

  // Browser: attach to window, same as every other js/*.js file here.
  // Node/test environment (no `window`): export via module.exports —
  // same dual-target pattern js/purchase-sheet.js and js/wizard-chips.js
  // already use.
  if (typeof window !== 'undefined') window.DreamCards = DreamCards;
  if (typeof module !== 'undefined' && module.exports) module.exports = DreamCards;
})();
