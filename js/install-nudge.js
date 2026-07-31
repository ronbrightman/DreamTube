// js/install-nudge.js
//
// Install-to-home-screen (A2HS) nudge — tracker item for-product-build-
// stage-0-pwa-web-push-f-jbutt5, which explicitly ABSORBS tracker item
// home-screen-shortcut-a2hs-nudge-founder--yylzoq's own placement
// analysis (founder buy-in already on the direction, exact wording/UI
// left to a light touch here):
//
//   "NOT possible inside the FB/IG in-app browser (add-to-home-screen
//   needs the real browser - Safari share sheet / Chrome menu - and
//   in-app webviews expose neither). So placement must be where users
//   are ALREADY in a real browser: (1) best moment - right after the
//   session-transfer link lands them signed-in in Safari/Chrome (they
//   just escaped the webview; one more it-gets-better step fits); (2)
//   also: repeat visitors on result/profile in a real browser. iOS
//   Safari cannot trigger A2HS programmatically - show instructions
//   (share icon -> Add to Home Screen). Android Chrome can show a real
//   install prompt if we add a PWA manifest trigger."
//
// This is a SEPARATE nudge from processing.html's existing
// initInAppNudge/#proc-nudge-card (which shows INSIDE a detected FB/IG
// webview, telling the visitor how to escape it) — this one only ever
// shows OUTSIDE a webview, in a real browser, per the analysis above.
// Reuses DreamStore.detectInAppWebviewHost (js/store.js) — the exact
// existing shared webview-detection source of truth every other
// in-app-browser-aware feature in this codebase already uses — rather
// than a second copy, and js/pwa.js's PwaInstall for the real Android
// beforeinstallprompt capture / iOS detection / already-installed check.
//
// Call `InstallNudge.init({ trigger: 'session-transfer' })` right after
// consuming a `?bt=` token (processing.html/result.html), or
// `InstallNudge.init({ trigger: 'repeat-visit', pageKey: 'result' })` on
// a page that should nudge REPEAT (not first-time) real-browser visitors
// (result.html/profile.html, per the analysis above).
//
// ===== 2026-07-29 revision (tracker item for-product-a2hs-install-nudge-
// 3-founder-vcofk7) =====
// Three founder-found problems with a real Safari test, fixed here:
//   1. UNCLEAR GUIDANCE — "tap the Share icon" text alone wasn't enough,
//      even on real Safari. FOLLOW-UP CORRECTION (same day, real founder
//      screenshots of his actual device): current Safari on iOS does NOT
//      show a direct Share icon in its bottom toolbar at all — the real
//      toolbar is back-chevron / address-bar-pill / a "•••" (More) button
//      at the bottom-RIGHT, and tapping that opens a small menu with
//      Share as its own first item, which THEN opens the real share
//      sheet. The first version of buildIOSGuidanceHtml below (a share
//      icon centered in the toolbar, "usually bottom-center") matched
//      neither of those screenshots — rebuilt directly from them: the
//      toolbar mock now shows the real back/url/••• layout with the •••
//      button highlighted, followed by a small "Share" menu-row visual
//      (the actual popup menu's first item) BEFORE the existing "Add to
//      Home Screen" row visual, plus explicit "scroll down" guidance —
//      the founder's own screenshot confirmed the missing option was
//      below the fold in the real share sheet, not actually absent.
//   2. MISSING OPTION — there's no JS-observable API into Safari's actual
//      share-sheet contents, so the fix is (a) keep hasSomethingToOffer/
//      shouldConsiderShowing below as tight as they can practically be
//      (confirmed correct already — see their own doc comments), and (b)
//      never claim the option WILL be there — buildIOSGuidanceHtml's copy
//      says "usually looks like" and "can vary by browser," never a flat
//      promise. Private-browsing detection was explicitly considered and
//      rejected: there is no reliable, version-stable JS signal for Safari
//      private-browsing mode today (the old FileSystem-API-quota trick was
//      deliberately closed off by Apple years ago to stop exactly this
//      kind of fingerprinting, and no public replacement exists) — a
//      heuristic here would produce false positives that wrongly hide the
//      nudge for many ordinary, non-private visitors, which is worse than
//      the honest "can vary" copy already handles.
//   3. ONE-SHOT DISAPPEARANCE — the homepage journey card (home.html,
//      #card-install) is now the PERSISTENT step that stays until
//      DreamStore.getInstallVerified() is genuinely true (a real
//      standalone-launch/appinstalled signal — see js/pwa.js), never on a
//      mere dismiss. THIS card (the small one below) keeps its original
//      one-shot-permanent dismiss semantics — it's the lighter-weight nudge
//      now, not the only chance to install.
//
// ===== 2026-07-31 revision (tracker item for-product-bug-research-founder-
// high-ad-vnda9t) =====
// Founder real-device report: A2HS "doesn't do anything" in Safari and
// "doesn't even appear as an option" in Chrome, on his own iPhone (iOS
// 26-era, iPhone 17). Root-caused via fresh at-source research (not
// from-memory platform claims — see that item's own resolution comment for
// full citations), not guessed at:
//   - buildIOSGuidanceHtml() below used to show every iOS browser the SAME
//     Safari-specific visual (a "•••" More button at bottom-right of the
//     toolbar). That's real and accurate FOR SAFARI (rebuilt from the
//     founder's own screenshots, 2026-07-29) — but Chrome on iOS has a
//     completely different real UI: a direct Share icon at the right of
//     its address bar (confirmed via Google's own support page,
//     support.google.com/chrome/answer/9658361), no "•••" More-button-then-
//     Share detour at all. Showing a Chrome user a mock of a button that
//     isn't there in that form is exactly the kind of "instruction that
//     can't be completed as described" this feature's own no-fake-buttons
//     discipline exists to prevent — very plausibly why the founder
//     reported the option as not appearing at all in Chrome (he was
//     correctly looking for what the guidance described, which Chrome
//     simply doesn't have in that place).
//   - PwaInstall.isIOS() itself was never wrong (no iOS browser can ever
//     fire beforeinstallprompt — confirmed still true; there remains NO
//     programmatic A2HS trigger anywhere on iOS), but its OWN doc comment's
//     claim that "the Add-to-Home-Screen mechanism is the same OS-level
//     share-sheet action regardless of which iOS browser is showing it"
//     conflated the shared DESTINATION action (real — both browsers
//     ultimately hand off to Apple's own SFAddToHomeScreenActivityItem
//     system API) with the PATH to reach it, which is not shared at all.
//   - Split into three real per-browser guidance builders below
//     (buildSafariGuidanceHtml/buildChromeIOSGuidanceHtml/
//     buildOtherIOSGuidanceHtml), selected via PwaInstall.iosBrowserKind()
//     (new — see js/pwa.js's own doc comment for the UA-token detection and
//     its citations). Chrome's guidance is deliberately honest about a
//     second real, separately-confirmed platform quirk: Apple Community and
//     Google Chrome Community threads document Chrome's iOS share sheet
//     sometimes needing a one-time "Edit Actions" step before "Add to Home
//     Screen" appears in it at all — mentioned directly rather than
//     silently omitted, since omitting it would leave exactly the founder's
//     reported "doesn't even appear" experience unexplained and unfixable
//     from the guidance alone. Firefox/Edge/Opera-on-iOS (rare in this
//     app's real traffic, unverified current layout) get an honest generic
//     fallback that never invents a specific button location for a browser
//     nobody has actually screenshotted here, plus a nudge toward Safari as
//     the one path this codebase has actually confirmed against a real
//     device.
window.InstallNudge = (function () {
  /** Fire-and-forget PostHog capture, same guarded shape as every other page's own local track() helper (see result.html/shop.html) — this module is shared across pages, so it gets its own copy rather than depending on one page's local function existing. */
  function track(name, props) {
    if (window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  /**
   * The mock Safari/Chrome toolbar visuals below display a URL-bar pill —
   * this reads the real current host (location.host, e.g. includes a
   * non-default port if present) rather than a hardcoded domain literal,
   * so the mock stays accurate across environments (local dev, any future
   * custom domain) with zero code change needed at cutover time. Falls
   * back to the current production host only in the (practically never
   * hit in a real browser) case location.host is somehow empty.
   */
  function currentHostForToolbarMock() {
    return (window.location && window.location.host) || 'dreamtube1.netlify.app';
  }

  /**
   * True only when there's something real and actionable to show:
   * Android/Chrome with a captured beforeinstallprompt (a genuine native
   * install dialog), or iOS Safari-family (manual Share -> Add to Home
   * Screen instructions — the only thing possible there, see PwaInstall.
   * isIOS's own doc comment). A desktop browser or any other platform
   * with neither signal has nothing meaningful to offer, so this nudge
   * stays silent rather than showing empty/confusing instructions.
   */
  function hasSomethingToOffer() {
    if (window.PwaInstall && window.PwaInstall.isIOS()) return true;
    return !!(window.PwaInstall && window.PwaInstall.canPromptInstall());
  }

  /**
   * Every capability-detect gate EXCEPT the small nudge card's own
   * device-level dismiss flag — factored out so home.html's persistent
   * journey card can reuse the exact same "is this genuinely possible
   * right now" logic without also inheriting a dismiss state that belongs
   * only to the small card (see this file's 2026-07-29 revision note
   * above on why the two cards' dismiss semantics are deliberately
   * different).
   */
  function canOfferInstall() {
    if (!window.DreamStore || !window.PwaInstall) return false;
    // Standing rule (this feature's own "What NOT to do" instruction):
    // never show an impossible-to-complete A2HS instruction inside FB/IG's
    // in-app browser — reuses the exact existing detection function, not a
    // reinvented copy.
    if (DreamStore.detectInAppWebviewHost()) return false;
    if (PwaInstall.isStandalone()) return false;
    if (!hasSomethingToOffer()) return false;
    return true;
  }

  function shouldConsiderShowing() {
    if (!canOfferInstall()) return false;
    if (DreamStore.getInstallNudgeDismissed()) return false;
    return true;
  }

  /**
   * Safari's own real toolbar-based guidance — rebuilt directly from the
   * founder's own real-device screenshots (see this file's 2026-07-29
   * revision note above): a mock of Safari's ACTUAL bottom toolbar (back
   * chevron / address-bar pill / a highlighted "•••" More button at the
   * bottom-right — Icons.moreHoriz, not a direct share icon), then a
   * small "Share" menu-row visual (Icons.shareIos, the same glyph already
   * used by result.html's topbar Share button — reused, not reinvented)
   * depicting the popup menu's own first item, THEN the existing "Add to
   * Home Screen" row visual. Three real visuals in sequence, matching the
   * three real screens a visitor actually walks through, not one bare
   * icon floating with no context. CSS/SVG only, no image/canvas payload,
   * matching this app's "keep it light for webview" principle. Deliberately
   * never promises the "Add to Home Screen" row will be exactly there
   * (problem 2, 2026-07-29 revision note) — "usually looks like," "can
   * vary."
   */
  function buildSafariGuidanceHtml() {
    var backIcon = window.Icons ? Icons.back : '‹';
    var moreIcon = window.Icons ? Icons.moreHoriz : '•••';
    var shareIcon = window.Icons ? Icons.shareIos : '';
    var plusIcon = window.Icons ? Icons.plus : '+';
    return (
      '<div class="install-nudge-visual" aria-hidden="true">' +
        '<div class="install-nudge-toolbar">' +
          '<span class="install-nudge-toolbar-back">' + backIcon + '</span>' +
          '<span class="install-nudge-toolbar-url">' + currentHostForToolbarMock() + '</span>' +
          '<span class="install-nudge-toolbar-more">' + moreIcon + '</span>' +
        '</div>' +
        '<div class="install-nudge-toolbar-arrow">▲ Tap here (bottom-right)</div>' +
      '</div>' +
      '<div class="install-nudge-body">Tap the <b>••• (More)</b> button — usually at the <b>bottom-right</b> of your screen in Safari (shown above).</div>' +
      '<div class="menu-row-replica install-nudge-menurow" aria-hidden="true">' +
        '<span class="menu-row-replica-icon">' + shareIcon + '</span>' +
        '<span class="menu-row-replica-label">Share</span>' +
      '</div>' +
      '<div class="install-nudge-body">Tap <b>Share</b>, then <b>scroll down</b> the list that opens — “Add to Home Screen” is often further down than it looks. It usually looks like this:</div>' +
      '<div class="menu-row-replica install-nudge-menurow" aria-hidden="true">' +
        '<span class="menu-row-replica-icon">' + plusIcon + '</span>' +
        '<span class="menu-row-replica-label">Add to Home Screen</span>' +
      '</div>' +
      '<div class="install-nudge-note">Exact wording, icon, and position can vary by Safari version.</div>'
    );
  }

  /**
   * Chrome-on-iOS's real UI is genuinely different from Safari's, not just
   * a relabeled copy — see this file's 2026-07-31 revision note above and
   * js/pwa.js's iosBrowserKind() doc comment for the research citations. A
   * direct Share icon at the right of the address bar (Google's own
   * support doc), not Safari's bottom "•••" More-button detour. Also
   * mentions the real, separately-documented "Edit Actions" quirk (Apple
   * Community / Google Chrome Community threads: Chrome's share sheet can
   * need a one-time opt-in before "Add to Home Screen" shows up in it at
   * all) — the most plausible explanation for the founder's own "doesn't
   * even appear" report, and something no amount of "scroll down" guidance
   * alone would have fixed.
   */
  function buildChromeIOSGuidanceHtml() {
    var backIcon = window.Icons ? Icons.back : '‹';
    var shareIcon = window.Icons ? Icons.shareIos : '';
    var plusIcon = window.Icons ? Icons.plus : '+';
    return (
      '<div class="install-nudge-visual" aria-hidden="true">' +
        '<div class="install-nudge-toolbar">' +
          '<span class="install-nudge-toolbar-back">' + backIcon + '</span>' +
          '<span class="install-nudge-toolbar-url">' + currentHostForToolbarMock() + '</span>' +
          '<span class="install-nudge-toolbar-highlight">' + shareIcon + '</span>' +
        '</div>' +
        '<div class="install-nudge-toolbar-arrow">▲ Tap here</div>' +
      '</div>' +
      '<div class="install-nudge-body">In Chrome, tap the <b>Share</b> icon — usually at the <b>right of the address bar</b> (shown above).</div>' +
      '<div class="menu-row-replica install-nudge-menurow" aria-hidden="true">' +
        '<span class="menu-row-replica-icon">' + plusIcon + '</span>' +
        '<span class="menu-row-replica-label">Add to Home Screen</span>' +
      '</div>' +
      '<div class="install-nudge-body">Then tap <b>Add to Home Screen</b>. Don\'t see it in the list? Scroll down, or tap <b>Edit Actions</b> at the bottom and add it from there — Chrome sometimes needs that one-time step.</div>' +
      '<div class="install-nudge-note">Chrome\'s menu layout can vary by version — Safari has the most reliably tested path if this doesn\'t match what you see.</div>'
    );
  }

  /**
   * Honest fallback for iOS browsers this codebase hasn't actually
   * confirmed a real layout for (Firefox/Edge/Opera-on-iOS, or any other
   * vendor's UA token PwaInstall.iosBrowserKind() doesn't specifically
   * recognize) — never invents a specific button location it hasn't
   * verified, per this feature's own no-fake-buttons standing rule.
   */
  function buildOtherIOSGuidanceHtml(kind) {
    var label = kind === 'firefox' ? 'Firefox' : kind === 'edge' ? 'Edge' : kind === 'opera' ? 'Opera' : 'your browser';
    var plusIcon = window.Icons ? Icons.plus : '+';
    return (
      '<div class="install-nudge-body">Look for <b>Share</b> in ' + label + '\'s menu, then <b>Add to Home Screen</b>:</div>' +
      '<div class="menu-row-replica install-nudge-menurow" aria-hidden="true">' +
        '<span class="menu-row-replica-icon">' + plusIcon + '</span>' +
        '<span class="menu-row-replica-label">Add to Home Screen</span>' +
      '</div>' +
      '<div class="install-nudge-note">' + label + '\'s exact menu layout varies and hasn\'t been verified here — Safari has the most reliably tested path.</div>'
    );
  }

  /**
   * Dispatches to the right per-browser guidance builder — see this file's
   * 2026-07-31 revision note above for why a single shared visual stopped
   * being accurate. Reused by THREE callers: this module's own render()
   * below, home.html's persistent journey-card sheet, and
   * js/push-subscribe.js's iOS-browser-tab push fallback (see that file's
   * own header comment) — one shared dispatch for "how to add to your home
   * screen" everywhere it's explained, not three copies.
   */
  function buildIOSGuidanceHtml() {
    var kind = (window.PwaInstall && typeof PwaInstall.iosBrowserKind === 'function') ? PwaInstall.iosBrowserKind() : 'safari';
    if (kind === 'chrome') return buildChromeIOSGuidanceHtml();
    if (kind === 'safari') return buildSafariGuidanceHtml();
    return buildOtherIOSGuidanceHtml(kind);
  }

  function render() {
    if (document.getElementById('install-nudge-card')) return; // already rendered this load

    var card = document.createElement('div');
    card.className = 'install-nudge-card';
    card.id = 'install-nudge-card';

    var onIOS = window.PwaInstall.isIOS();
    var iconMarkup = window.Icons ? Icons.download : '';

    card.innerHTML =
      '<button type="button" class="install-nudge-x" id="install-nudge-dismiss" aria-label="Dismiss">&times;</button>' +
      '<div class="install-nudge-head"><span class="install-nudge-dot">' + iconMarkup + '</span><span>Add DreamTube to your home screen</span></div>' +
      (onIOS
        ? buildIOSGuidanceHtml()
        : ('<div class="install-nudge-body">One tap and you\'re set — open your dreams like any other app, no browser tabs.</div>' +
           '<button type="button" class="install-nudge-btn" id="install-nudge-action">Install <span class="icon">' + (window.Icons ? Icons.download : '') + '</span></button>'));

    document.body.appendChild(card);
    track('install_nudge_shown', { platform: onIOS ? 'ios' : 'android' });

    document.getElementById('install-nudge-dismiss').addEventListener('click', function () {
      DreamStore.dismissInstallNudge();
      card.remove();
      track('install_nudge_dismissed', { platform: onIOS ? 'ios' : 'android' });
    });

    if (!onIOS) {
      var actionBtn = document.getElementById('install-nudge-action');
      actionBtn.addEventListener('click', function () {
        window.PwaInstall.promptInstall().then(function (outcome) {
          track('install_nudge_outcome', { outcome: outcome || 'unavailable' });
          if (outcome === 'accepted') DreamStore.dismissInstallNudge();
          card.remove();
        });
      });
    }
  }

  /**
   * `opts.trigger`: 'session-transfer' (fires only if
   * DreamStore.wasSessionJustTransferred() is true for THIS load — see
   * that function's own doc comment) or 'repeat-visit' (fires only once
   * DreamStore.recordRealBrowserVisit(opts.pageKey) reports this browser's
   * 2nd+ visit to that page). Any other/missing trigger is a silent no-op
   * — this nudge only ever shows at one of these two deliberate moments,
   * never on a bare/first page load.
   */
  function init(opts) {
    opts = opts || {};
    var eligibleTrigger = false;
    if (opts.trigger === 'session-transfer') {
      eligibleTrigger = !!(window.DreamStore && DreamStore.wasSessionJustTransferred());
    } else if (opts.trigger === 'repeat-visit') {
      var count = window.DreamStore ? DreamStore.recordRealBrowserVisit(opts.pageKey || 'generic') : 0;
      eligibleTrigger = count >= 2;
    }
    if (!eligibleTrigger) return;
    if (!shouldConsiderShowing()) return;
    render();
  }

  return {
    init: init,
    canOfferInstall: canOfferInstall,
    buildIOSGuidanceHtml: buildIOSGuidanceHtml
  };
})();
