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
window.InstallNudge = (function () {
  /** Fire-and-forget PostHog capture, same guarded shape as every other page's own local track() helper (see result.html/shop.html) — this module is shared across pages, so it gets its own copy rather than depending on one page's local function existing. */
  function track(name, props) {
    if (window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
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

  function shouldConsiderShowing() {
    if (!window.DreamStore || !window.PwaInstall) return false;
    // Standing rule (this feature's own "What NOT to do" instruction):
    // never show an impossible-to-complete A2HS instruction inside FB/IG's
    // in-app browser — reuses the exact existing detection function, not a
    // reinvented copy.
    if (DreamStore.detectInAppWebviewHost()) return false;
    if (PwaInstall.isStandalone()) return false;
    if (DreamStore.getInstallNudgeDismissed()) return false;
    if (!hasSomethingToOffer()) return false;
    return true;
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
      '<div class="install-nudge-body">' + (onIOS
        ? 'Tap the Share icon, then "Add to Home Screen" — open your dreams like any other app.'
        : 'One tap and you\'re set — open your dreams like any other app, no browser tabs.') + '</div>' +
      (onIOS ? '' : '<button type="button" class="install-nudge-btn" id="install-nudge-action">Install <span class="icon">' + (window.Icons ? Icons.download : '') + '</span></button>');

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

  return { init: init };
})();
