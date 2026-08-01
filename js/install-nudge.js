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
// This is a SEPARATE nudge from home.html's own .webview-card (rehomed
// there from the now-removed processing.html's initInAppNudge/
// #proc-nudge-card — see home.html's own ORPHAN (b) comment; shows INSIDE
// a detected FB/IG webview, telling the visitor how to escape it) — this
// one only ever shows OUTSIDE a webview, in a real browser, per the
// analysis above. Reuses DreamStore.detectInAppWebviewHost (js/store.js) —
// the exact existing shared webview-detection source of truth every other
// in-app-browser-aware feature in this codebase already uses — rather
// than a second copy, and js/pwa.js's PwaInstall for the real Android
// beforeinstallprompt capture / iOS detection / already-installed check.
//
// Call `InstallNudge.init({ trigger: 'session-transfer' })` right after
// consuming a `?bt=` token (create.html/result.html), or
// `InstallNudge.init({ trigger: 'repeat-visit', pageKey: 'profile' })` on
// a page that should nudge REPEAT (not first-time) real-browser visitors
// (profile.html, per the analysis above).
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
//
// ===== 2026-08-01 revision (tracker item for-product-install-first-door-
// founder-d-b60cls) =====
// Founder directive: don't stop at "escaped the webview" — the goal is the
// home-screen ICON, preferred over everything (standalone launch, no funnel
// re-entry, and it's what makes push possible at all). Reshaped the escape
// -> install journey into ONE guided two-step flow rather than two
// unrelated nudges that happened to fire near each other. (processing.html
// no longer exists in this codebase as of the ORPHAN a/b rehoming into
// home.html — see that page's own header comments — so "Step 1" below
// lives on home.html now, not the old #proc-nudge-card.)
//   STEP 1 (still inside the webview) — home.html's existing .webview-card
//   (an elevated state of its own "Add DreamTube to your phone" quiet row;
//   copy-link / open-in-Chrome, ported verbatim from the now-removed
//   processing.html) is now explicitly framed there as "Step 1 of 2" (see
//   home.html's own comments for the framing change; the underlying copy/
//   open mechanism itself is untouched, this item is assembly + framing on
//   already-working plumbing, not a rebuild).
//   STEP 2 (this file, `trigger: 'session-transfer'`) — the moment
//   create.html/result.html call InstallNudge.init() right after consuming
//   the ?bt= token IS the "just landed in a real browser" moment, so it's
//   now explicitly labeled "Step 2 of 2" and made platform-aware in two new
//   ways that used to leave a real gap. home.html itself doesn't call
//   InstallNudge.init() (that would duplicate its own quiet row with a
//   second floating card — exactly the "two competing prompts" this item
//   says not to build) — instead its own installJourneyRow elevates the
//   SAME row into a "Step 2 of 2" state right after a fresh session
//   transfer, reusing buildAndroidMenuFallbackHtml/buildIOSOpenInSafariHtml/
//   wireIOSOpenInSafari below (exported for exactly this reuse) rather than
//   a second copy of this logic:
//     - ANDROID WITHOUT A CAPTURED PROMPT: beforeinstallprompt is async/
//       heuristic-gated (see js/pwa.js's own comment on this) — Chrome
//       doesn't always have it ready by the time this fires, and other
//       Android browsers never fire it at all. The OLD hasSomethingToOffer()
//       gate (still used, unchanged, everywhere else in this file) treated
//       that as "nothing to offer" and stayed silent — exactly the "dead
//       end at the one guided moment" this item exists to close. Step 2 now
//       uses the broadened hasSomethingToOfferForStep2() below, which lets
//       a plain Android UA through even without a captured prompt, so
//       render() can show a real "look in your browser's menu" fallback
//       (buildAndroidMenuFallbackHtml) instead of nothing at all.
//       Deliberately scoped to Step 2 only — broadening the strict version
//       instead would make home.html's persistent row (and the small card's
//       own repeat-visit trigger) show for every Android visit regardless
//       of real installability, which is not this fix's job.
//     - IPHONE ON A NON-SAFARI BROWSER: the founder's own explicit call for
//       this feature ("Safari is the only browser capable of A2HS on iOS...
//       non-Safari must be told to open in Safari first — never leave them
//       at a dead end") is a deliberate SIMPLIFICATION for this one guided
//       moment specifically, not a reversal of the 2026-07-31 revision
//       above: buildIOSGuidanceHtml()'s per-browser dispatch (Chrome/
//       Firefox/Edge-on-iOS each get their own real, screenshotted-or-
//       documented guidance) stays exactly as-is and keeps firing for the
//       small card's repeat-visit trigger and home.html's persistent row —
//       both still covered by test/pwa-stage0-behavioral.test.js's Chrome-
//       iOS assertions, intentionally left unbroken. Step 2 specifically
//       (trigger: 'session-transfer', right after escaping a webview) uses
//       the new buildIOSOpenInSafariHtml() instead: a real `x-safari-
//       https://` link (the same iOS OS-level protocol-handler trick many
//       apps use to force a URL open in Safari specifically, not invented
//       here) plus an always-available copy-link fallback, so a non-Safari
//       iPhone visitor at this exact moment gets pointed at the ONE
//       universally reliable path rather than browser-specific menu-hunting
//       right when they're most likely to bounce.
//   PLUS — the "small, dismissible banner for returning non-installed
//   users" the founder also asked for is NOT a new third UI: it's this
//   file's own existing repeat-visit trigger (the small #install-nudge-card
//   on profile.html, dismissible, respects DreamStore.getInstallNudgeDismissed)
//   plus home.html's existing persistent quiet row (deliberately never
//   dismissible — see that row's own doc comment), aligned as ONE system
//   already (both gate on canOfferInstall(), which — as of this revision —
//   also excludes a genuinely DreamStore.getInstallVerified() account,
//   centralized here rather than left as home.html's own separate extra
//   check, so every consumer gets the same "already verified, stop asking"
//   behavior for free).
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
   * Broadened variant used ONLY for the Step 2 post-webview-escape install
   * moment (trigger: 'session-transfer') — tracker item for-product-
   * install-first-door-founder-d-b60cls, see this file's 2026-08-01
   * revision note above. Everywhere else (the small card's repeat-visit
   * trigger, home.html's persistent row) keeps using the strict
   * hasSomethingToOffer() above, unchanged.
   */
  function hasSomethingToOfferForStep2() {
    if (hasSomethingToOffer()) return true;
    return !!(window.PwaInstall && typeof PwaInstall.isAndroid === 'function' && PwaInstall.isAndroid());
  }

  /**
   * Every capability-detect gate EXCEPT the small nudge card's own
   * device-level dismiss flag — factored out so home.html's persistent
   * journey card can reuse the exact same "is this genuinely possible
   * right now" logic without also inheriting a dismiss state that belongs
   * only to the small card (see this file's 2026-07-29 revision note
   * above on why the two cards' dismiss semantics are deliberately
   * different). `offerCheckFn` defaults to the strict hasSomethingToOffer()
   * — Step 2 passes the broadened hasSomethingToOfferForStep2() instead
   * (see canOfferInstallForStep2 below).
   *
   * Also excludes a genuinely DreamStore.getInstallVerified() account
   * (2026-08-01 revision) — centralized here rather than left as an extra
   * check callers had to remember to add themselves; home.html used to
   * duplicate this same check locally, now redundant and removed there.
   */
  function canOfferInstallCore(offerCheckFn) {
    if (!window.DreamStore || !window.PwaInstall) return false;
    // Standing rule (this feature's own "What NOT to do" instruction):
    // never show an impossible-to-complete A2HS instruction inside FB/IG's
    // in-app browser — reuses the exact existing detection function, not a
    // reinvented copy.
    if (DreamStore.detectInAppWebviewHost()) return false;
    if (PwaInstall.isStandalone()) return false;
    if (typeof DreamStore.getInstallVerified === 'function' && DreamStore.getInstallVerified()) return false;
    if (!offerCheckFn()) return false;
    return true;
  }

  function canOfferInstall() {
    return canOfferInstallCore(hasSomethingToOffer);
  }

  function canOfferInstallForStep2() {
    return canOfferInstallCore(hasSomethingToOfferForStep2);
  }

  function shouldConsiderShowing(trigger) {
    var can = trigger === 'session-transfer' ? canOfferInstallForStep2() : canOfferInstall();
    if (!can) return false;
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

  /**
   * Step 2's Android fallback when no beforeinstallprompt has been
   * captured yet (canPromptInstall() false) — tracker item for-product-
   * install-first-door-founder-d-b60cls's "if the event never fired, fall
   * back to pointing at the browser menu's Install app option" directive.
   * Uses Icons.moreVert (a real vertical "⋮" glyph — Android's actual
   * overflow-menu icon, top-right) rather than reusing Safari's horizontal
   * "•••" moreHoriz, same no-fake-buttons discipline as the iOS guidance
   * builders above. Never promises the exact wording — real Android
   * browsers vary between "Install app" and "Add to Home screen" for the
   * same action.
   */
  function buildAndroidMenuFallbackHtml() {
    var moreIcon = window.Icons ? Icons.moreVert : '⋮';
    var downloadIcon = window.Icons ? Icons.download : '+';
    return (
      '<div class="install-nudge-visual" aria-hidden="true">' +
        '<div class="install-nudge-toolbar">' +
          '<span class="install-nudge-toolbar-url">' + currentHostForToolbarMock() + '</span>' +
          '<span class="install-nudge-toolbar-highlight">' + moreIcon + '</span>' +
        '</div>' +
        '<div class="install-nudge-toolbar-arrow">▲ Tap here (top-right menu)</div>' +
      '</div>' +
      '<div class="install-nudge-body">Tap your browser\'s menu — usually <b>⋮</b> at the <b>top-right</b> (shown above) — then look for:</div>' +
      '<div class="menu-row-replica install-nudge-menurow" aria-hidden="true">' +
        '<span class="menu-row-replica-icon">' + downloadIcon + '</span>' +
        '<span class="menu-row-replica-label">Install app</span>' +
      '</div>' +
      '<div class="install-nudge-note">Wording can vary by browser ("Install app," "Add to Home screen," or similar).</div>'
    );
  }

  /** Friendly display name for an iOS non-Safari browser kind, for buildIOSOpenInSafariHtml's copy below. */
  function iosBrowserLabel(kind) {
    if (kind === 'chrome') return 'Chrome';
    if (kind === 'firefox') return 'Firefox';
    if (kind === 'edge') return 'Edge';
    if (kind === 'opera') return 'Opera';
    return 'this browser';
  }

  /**
   * Step 2's iPhone-non-Safari path — founder directive (tracker item
   * for-product-install-first-door-founder-d-b60cls): "Safari is the only
   * browser capable of A2HS on iOS... non-Safari must be told to open in
   * Safari first — never leave them at a dead end." Deliberately scoped to
   * Step 2 only, NOT a change to buildIOSGuidanceHtml's dispatch above —
   * see this file's 2026-08-01 revision note for why.
   *
   * The "Open in Safari" link uses `x-safari-https://`/`x-safari-http://`
   * — a real iOS OS-level URL-scheme handler Safari registers (the same
   * mechanism many third-party apps already use to force a link open in
   * Safari specifically), not a fabricated scheme. Tapped as a real user
   * gesture (a genuine `<a href>`, not a scripted redirect) for the most
   * reliable custom-scheme handoff. Always paired with a copy-link
   * fallback that reuses the same clipboard-write pattern already proven
   * out by processing.html's own copyLinkForBrowser, so a visitor is never
   * left with only a single, unverifiable button and no other way forward.
   */
  function buildIOSOpenInSafariHtml() {
    var kind = (window.PwaInstall && typeof PwaInstall.iosBrowserKind === 'function') ? PwaInstall.iosBrowserKind() : 'safari';
    var label = iosBrowserLabel(kind);
    var url = (window.location && window.location.href) || '';
    var safariUrl = url.replace(/^https:\/\//, 'x-safari-https://').replace(/^http:\/\//, 'x-safari-http://').replace(/"/g, '&quot;');
    var externalIcon = window.Icons ? Icons.externalLink : '';
    var copyIcon = window.Icons ? Icons.copy : '';
    return (
      '<div class="install-nudge-body">Adding to your home screen only works in <b>Safari</b> on iPhone — ' + label + ' can\'t do it. Let\'s open Safari:</div>' +
      '<a class="install-nudge-btn" id="install-nudge-open-safari" href="' + safariUrl + '">Open in Safari <span class="icon">' + externalIcon + '</span></a>' +
      '<button type="button" class="install-nudge-btn install-nudge-btn-secondary" id="install-nudge-copy-for-safari">Copy link for Safari <span class="icon">' + copyIcon + '</span></button>' +
      '<div class="install-nudge-note" id="install-nudge-safari-fallback">If "Open in Safari" doesn\'t do anything, copy the link and paste it into Safari yourself.</div>'
    );
  }

  /**
   * Wires the two buttons buildIOSOpenInSafariHtml renders — factored out
   * of render() since it's the only guidance builder above with
   * interactive elements of its own (the others are pure display, wired
   * generically by render()'s existing dismiss/install handlers).
   *
   * Also asynchronously refreshes both the href and the copy-link target
   * with a FRESH session-transfer token, minted via
   * DreamStore.mintSessionTransferToken() — buildIOSOpenInSafariHtml's own
   * synchronous window.location.href read happens AFTER
   * consumeSessionTransferTokenFromUrlSync has already stripped that
   * page's own ?bt= param (every Step 2 caller — create.html/result.html —
   * consumes it before InstallNudge.init() ever runs, see those pages' own
   * script order), so without this the link handed to Safari would land
   * the visitor there SIGNED OUT, defeating the entire point of this
   * guided handoff. Mirrors the exact mechanism
   * DreamStore.maintainSessionTransferUrl() already uses to keep a
   * webview's own address bar carrying a live token — same mint call,
   * same "null just leaves the existing value in place, never surfaces an
   * error" resilience (mintSessionTransferToken's own doc comment) — just
   * applied to this button's href/copy target instead of location.href
   * itself, since rewriting the page's OWN address bar here (outside a
   * detected webview) is out of scope for this button.
   */
  function wireIOSOpenInSafari(trigger, platform) {
    var openBtn = document.getElementById('install-nudge-open-safari');
    var currentHref = openBtn ? openBtn.getAttribute('href') : '';

    if (window.DreamStore && typeof DreamStore.mintSessionTransferToken === 'function') {
      DreamStore.mintSessionTransferToken().then(function (token) {
        if (!token) return; // no-op on null -- see this function's own doc comment
        try {
          var url = new URL(window.location.href);
          url.searchParams.set('bt', token);
          var refreshed = url.toString().replace(/^https:\/\//, 'x-safari-https://').replace(/^http:\/\//, 'x-safari-http://');
          currentHref = refreshed;
          if (openBtn) openBtn.setAttribute('href', refreshed);
        } catch (e) { /* malformed URL API -- leave the href as originally rendered */ }
      });
    }

    if (openBtn) {
      openBtn.addEventListener('click', function () {
        track('install_nudge_outcome', { outcome: 'ios_open_safari_tapped', platform: platform, trigger: trigger || 'unknown' });
      });
    }
    var copyBtn = document.getElementById('install-nudge-copy-for-safari');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) return;
        // currentHref (already x-safari-... prefixed) carries the freshly
        // minted token once resolved above; falls back to the plain,
        // token-less current URL only if minting hasn't landed yet or
        // failed -- same graceful-degradation shape as the href itself.
        var toCopy = currentHref ? currentHref.replace(/^x-safari-https:\/\//, 'https://').replace(/^x-safari-http:\/\//, 'http://') : window.location.href;
        navigator.clipboard.writeText(toCopy).then(function () {
          var note = document.getElementById('install-nudge-safari-fallback');
          if (note) note.textContent = 'Copied! Open Safari and paste the link there.';
          track('install_nudge_outcome', { outcome: 'ios_copy_for_safari', platform: platform, trigger: trigger || 'unknown' });
        }).catch(function () { /* clipboard can legitimately be denied -- the note above stays as the honest fallback either way */ });
      });
    }
  }

  /**
   * `opts.trigger`: 'session-transfer' (Step 2 of the guided post-webview-
   * escape flow — see this file's 2026-08-01 revision note) or
   * 'repeat-visit' (the standalone small-card nudge, unchanged framing).
   */
  function render(opts) {
    opts = opts || {};
    if (document.getElementById('install-nudge-card')) return; // already rendered this load

    var isStepTwo = opts.trigger === 'session-transfer';
    var card = document.createElement('div');
    card.className = 'install-nudge-card';
    card.id = 'install-nudge-card';

    var onIOS = window.PwaInstall.isIOS();
    var iconMarkup = window.Icons ? Icons.download : '';
    var stepLabelHtml = isStepTwo ? '<div class="install-nudge-steplabel">Step 2 of 2</div>' : '';

    var iosKind = (window.PwaInstall && typeof PwaInstall.iosBrowserKind === 'function') ? PwaInstall.iosBrowserKind() : 'safari';
    var showIOSSafariRedirect = isStepTwo && onIOS && iosKind !== 'safari';
    var showAndroidMenuFallback = isStepTwo && !onIOS && !window.PwaInstall.canPromptInstall();

    var bodyHtml;
    if (onIOS) {
      bodyHtml = showIOSSafariRedirect ? buildIOSOpenInSafariHtml() : buildIOSGuidanceHtml();
    } else if (showAndroidMenuFallback) {
      bodyHtml = buildAndroidMenuFallbackHtml();
    } else {
      bodyHtml =
        '<div class="install-nudge-body">One tap and you\'re set — open your dreams like any other app, no browser tabs.</div>' +
        '<button type="button" class="install-nudge-btn" id="install-nudge-action">Install <span class="icon">' + (window.Icons ? Icons.download : '') + '</span></button>';
    }

    card.innerHTML =
      '<button type="button" class="install-nudge-x" id="install-nudge-dismiss" aria-label="Dismiss">&times;</button>' +
      stepLabelHtml +
      '<div class="install-nudge-head"><span class="install-nudge-dot">' + iconMarkup + '</span><span>Add DreamTube to your home screen</span></div>' +
      bodyHtml;

    document.body.appendChild(card);
    var platform = onIOS ? 'ios' : 'android';
    track('install_nudge_shown', { platform: platform, trigger: opts.trigger || 'unknown', step: isStepTwo ? 2 : 1 });

    document.getElementById('install-nudge-dismiss').addEventListener('click', function () {
      DreamStore.dismissInstallNudge();
      card.remove();
      track('install_nudge_dismissed', { platform: platform, trigger: opts.trigger || 'unknown' });
    });

    if (!onIOS && !showAndroidMenuFallback) {
      var actionBtn = document.getElementById('install-nudge-action');
      actionBtn.addEventListener('click', function () {
        window.PwaInstall.promptInstall().then(function (outcome) {
          track('install_nudge_outcome', { outcome: outcome || 'unavailable', platform: platform, trigger: opts.trigger || 'unknown' });
          if (outcome === 'accepted') DreamStore.dismissInstallNudge();
          card.remove();
        });
      });
    }

    if (showIOSSafariRedirect) {
      wireIOSOpenInSafari(opts.trigger, platform);
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
    if (!shouldConsiderShowing(opts.trigger)) return;
    render(opts);
  }

  return {
    init: init,
    canOfferInstall: canOfferInstall,
    buildIOSGuidanceHtml: buildIOSGuidanceHtml,
    // Exported for tracker item for-product-install-first-door-founder-d-
    // b60cls: home.html's own install-qrow/sheet (its "one system, not two
    // competing prompts" install surface) reuses these same three Step 2
    // builders/wirer rather than duplicating the Android-menu-fallback/
    // iOS-open-in-Safari logic a second time — see home.html's own
    // installJourneyRow for how. canOfferInstallForStep2 is exported
    // alongside them for the same reason: installJourneyRow's own
    // shouldShow() must use the broadened Step 2 check too (see that
    // function's own doc comment above), not just the strict default —
    // otherwise the row never becomes visible for a plain Android UA with
    // no captured beforeinstallprompt, and the fallback builders below
    // become unreachable.
    canOfferInstallForStep2: canOfferInstallForStep2,
    buildAndroidMenuFallbackHtml: buildAndroidMenuFallbackHtml,
    buildIOSOpenInSafariHtml: buildIOSOpenInSafariHtml,
    wireIOSOpenInSafari: wireIOSOpenInSafari
  };
})();
