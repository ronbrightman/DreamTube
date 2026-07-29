// js/pwa.js
//
// Plain script (no ES modules, matches js/store.js's own convention — see
// CLAUDE.md), included on every real app page right after js/store.js.
// Two small, independent jobs, both part of tracker item for-product-
// build-stage-0-pwa-web-push-f-jbutt5's "PWA manifest + service worker"
// scope:
//
//   1. Registers sw.js (see that file's header comment for the caching
//      strategy) — guarded so this is a safe no-op in every environment
//      that can't support it (no serviceWorker API at all, or a file://
//      load during local static-server-less testing, where the Service
//      Worker spec itself refuses to register against a non-http(s)
//      origin).
//   2. Captures the browser's `beforeinstallprompt` event the instant it
//      fires (Android Chrome/Edge only — iOS Safari and Firefox never
//      fire this event at all) so js/install-nudge.js's later, deliberate
//      "show the nudge now" moment can still trigger the REAL native
//      install prompt via PwaInstall.promptInstall() — the event is only
//      ever delivered once per page load and must be captured immediately
//      (and preventDefault()'d, to suppress the browser's own default mini-
//      infobar) or it's lost for that load.
window.PwaInstall = (function () {
  var deferredPrompt = null;
  var installedFlag = false;

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      installedFlag = true;
    });
  }

  /** True once a real native beforeinstallprompt has been captured on THIS page load and hasn't been consumed yet — the only way to know, ahead of time, whether promptInstall() below can show a real Android/Chrome install dialog right now. Always false on iOS Safari/Firefox (they never fire the event) and on any browser where installability criteria (manifest + service worker + icons) aren't yet satisfied. */
  function canPromptInstall() {
    return !!deferredPrompt;
  }

  /**
   * Shows the real, captured native install prompt. Resolves the user's
   * choice ('accepted'/'dismissed'), or null if there was nothing captured
   * to show (caller should have checked canPromptInstall() first — this
   * is just a defensive fallback, never throws). The captured event can
   * only ever be used once, so this always clears `deferredPrompt`
   * afterward regardless of outcome.
   */
  function promptInstall() {
    if (!deferredPrompt) return Promise.resolve(null);
    var prompt = deferredPrompt;
    deferredPrompt = null;
    prompt.prompt();
    return prompt.userChoice.then(function (choice) {
      return choice && choice.outcome;
    }).catch(function () {
      return null;
    });
  }

  /** True if this page is currently running as an already-installed PWA (standalone display mode) — covers both the standard matchMedia check (Android/desktop Chrome) and iOS Safari's older `navigator.standalone` flag (iOS never supports the standard media query the same way). Used to skip the install nudge entirely for someone who already installed. */
  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* ignore */ }
    return !!(window.navigator && window.navigator.standalone);
  }

  /** True on an iOS/iPadOS Safari-family browser — the one platform that can NEVER fire beforeinstallprompt, so the install nudge must fall back to manual "tap Share -> Add to Home Screen" instructions there instead of a real native prompt. Excludes Chrome-on-iOS/Firefox-on-iOS (they use Apple's forced WebKit engine too and also can't show a native prompt, but explicitly naming "Safari" in the instructions would be wrong for those — this just checks the OS, not the specific browser chrome, since the Add-to-Home-Screen mechanism itself is the same OS-level share-sheet action regardless of which iOS browser is showing it). */
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Macintosh') !== -1 && navigator.maxTouchPoints > 1);
  }

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Service Worker registration itself throws for a non-http(s) origin
    // (e.g. this repo's pages opened directly via file:// during ad hoc
    // local testing, or Playwright's file:// fallback) — guard explicitly
    // rather than relying solely on the try/catch below, since some
    // engines reject the registration Promise asynchronously in a way a
    // bare .catch still handles fine, but this is cheap and avoids even
    // attempting a call that's guaranteed to fail.
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    try {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // Registration can legitimately fail (unsupported context, a
        // restrictive browser setting) -- this must never break the page
        // it's loaded from.
      });
    } catch (e) { /* same discipline as every other analytics/PWA-adjacent call in this codebase -- must never break the app */ }
  }

  registerServiceWorker();

  return {
    canPromptInstall: canPromptInstall,
    promptInstall: promptInstall,
    isStandalone: isStandalone,
    isIOS: isIOS
  };
})();
