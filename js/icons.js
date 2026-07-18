// js/icons.js
//
// Plain script (matches store.js's convention — no ES modules) exposing a
// small shared library of line-style SVG icons, replacing emoji throughout
// the app per the Instagram-style redesign. Every icon is a 24x24 viewBox,
// sized via width/height="1em" so it scales with the font-size of whatever
// wraps it (.icon-btn, .nav-icon, .ig-icon, etc.) instead of needing a
// separate sizing rule per usage site.
//
// back/heart/comment/share/repost/home/search/person/settings are reused
// verbatim from the design-reference.html mockup so Explore/Home/Profile
// match it exactly.

(function () {
  function svg(inner, attrs) {
    return '<svg width="1em" height="1em" viewBox="0 0 24 24"' + (attrs || '') + '>' + inner + '</svg>';
  }

  window.Icons = {
    back: svg('<path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    home: svg('<path d="M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3z" fill="currentColor"/>'),

    search: svg('<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M21 21l-4.3-4.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),

    compass: svg('<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M16.24 7.76L14.12 14.12L7.76 16.24L9.88 9.88Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>'),

    person: svg('<circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>'),

    settings: svg('<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09A1.65 1.65 0 0015.4 4.6a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    heartOutline: svg('<path d="M12 21s-7.5-4.6-10.1-9.1C.3 8.8 1.4 5 5 4.2c2-.5 4 .3 5.2 2 .3.4.6.9.8 1.3.2-.4.5-.9.8-1.3 1.2-1.7 3.2-2.5 5.2-2 3.6.8 4.7 4.6 3.1 7.7C19.5 16.4 12 21 12 21z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>'),

    heartFilled: svg('<path d="M12 21s-7.5-4.6-10.1-9.1C.3 8.8 1.4 5 5 4.2c2-.5 4 .3 5.2 2 .3.4.6.9.8 1.3.2-.4.5-.9.8-1.3 1.2-1.7 3.2-2.5 5.2-2 3.6.8 4.7 4.6 3.1 7.7C19.5 16.4 12 21 12 21z" fill="#FF3040"/>'),

    comment: svg('<path d="M21 11.5a8.4 8.4 0 01-4.7 7.6 8.5 8.5 0 01-9.4-1L3 19l1-3.8a8.4 8.4 0 01-1-4 8.5 8.5 0 018.5-8.5A8.5 8.5 0 0121 11.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>'),

    share: svg('<path d="M22 2L11 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    repost: svg('<path d="M17 2l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 11V9a4 4 0 014-4h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M7 22l-4-4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M21 13v2a4 4 0 01-4 4H3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    pencil: svg('<path d="M12 20h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    mic: svg('<rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 10v1a7 7 0 0014 0v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M12 18v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9 22h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),

    palette: svg('<path d="M12 2a10 10 0 100 20c1.4 0 2-1 2-2 0-.6-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a3 3 0 003-3c0-5-3.6-10.5-8-10.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><circle cx="7" cy="10" r="1.3" fill="currentColor"/><circle cx="9.5" cy="6.5" r="1.3" fill="currentColor"/><circle cx="14.5" cy="6.5" r="1.3" fill="currentColor"/><circle cx="17" cy="10" r="1.3" fill="currentColor"/>'),

    globe: svg('<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M2 12h20" stroke="currentColor" stroke-width="1.8"/><path d="M12 2a15.3 15.3 0 010 20" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M12 2a15.3 15.3 0 000 20" stroke="currentColor" stroke-width="1.8" fill="none"/>'),

    bell: svg('<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M13.7 21a2 2 0 01-3.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>'),

    redo: svg('<path d="M3 11a9 9 0 1 1 2.6 6.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M3 4v7h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    close: svg('<path d="M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),

    warning: svg('<path d="M12 9v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 17h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/>'),

    check: svg('<path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    play: svg('<path d="M8 5v14l11-7z" fill="currentColor"/>'),

    pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/>'),

    trash: svg('<path d="M3 6h18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M19 6l-1 14a1 1 0 01-1 1H7a1 1 0 01-1-1L5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M10 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),

    chevronDown: svg('<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),

    plus: svg('<path d="M12 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),

    userPlus: svg('<circle cx="9" cy="8" r="4" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M2 20c0-4 3.1-6 7-6s7 2 7 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M19 8v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 11h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>')
  };
})();
