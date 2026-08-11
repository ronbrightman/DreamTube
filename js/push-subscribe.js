// js/push-subscribe.js
//
// Web Push subscribe flow — tracker item for-product-build-stage-0-pwa-
// web-push-f-jbutt5, part 3. Plain script (no ES modules — matches
// js/store.js's own convention, see CLAUDE.md), depends on js/pwa.js
// (service worker must already be registering) and js/push-config.js
// (VAPID_PUBLIC_KEY) both being loaded first.
//
// WHEN THIS ASKS: home.html calls maybeShowAsk() on a normal logged-in
// home visit — see that page's refreshNotifyCard for exactly where. (This
// used to fire only "right after a first video starts generating"; founder
// ask 2026-08-11 loosened it to show on every logged-in home visit, since
// the generation-only gate meant almost nobody was ever prompted and so
// almost nobody subscribed. The high-intent-only rationale in this module's
// original design is superseded by that decision; the module's own gating
// below is unchanged — only the call site's WHEN changed.)
// Asked at most ONCE EVER per browser (DreamStore.getPushAskDismissed/
// dismissPushAsk — a device-level marker, same reasoning as the install
// nudge's own dismissal marker: this belongs to whoever is holding the
// device, not to whichever account happens to be signed in) — never
// re-shown on every later generation, and never shown at all once
// Notification.permission is anything other than 'default' (already
// answered, one way or the other, at the OS level — re-asking there would
// either be a no-op or, worse on some browsers, do nothing visible at
// all).
//
// STANDING RULE, same as the install nudge (js/install-nudge.js): never
// show this inside a detected FB/IG in-app webview — those webviews
// frequently block or silently no-op the Notification/Push APIs
// entirely, and even where they don't, a subscription minted inside a
// webview's own ephemeral context is unlikely to ever receive a push
// reliably. Reuses the exact same DreamStore.detectInAppWebviewHost
// shared source of truth every other in-app-browser-aware feature in
// this codebase already uses.
//
// ===== 2026-07-29 addition: iOS-browser-tab push fallback chaining
// (tracker item for-product-a2hs-install-nudge-3-founder-vcofk7's later
// comment) =====
// isSupported() correctly returns false on an iOS browser TAB (Apple only
// exposes PushManager to an installed home-screen web app), so
// maybeShowAsk() used to silently no-op there — technically correct, but
// reads as "notifications are just broken" to a visitor who never sees
// anything. Fixed: when push is unsupported SPECIFICALLY because of "iOS +
// real browser tab, not standalone" (isIOSBrowserTabUnsupported below —
// NOT desktop-unsupported or any other reason, which stay silent exactly
// as before), maybeShowAsk renders a chained fallback message instead of
// nothing: "notifications need the installed app... add DreamTube to your
// home screen," which expands in place to the SAME iOS guidance
// js/install-nudge.js's small card shows (InstallNudge.buildIOSGuidanceHtml
// — one shared visual language, not a second copy). Push becomes available
// naturally once they're running installed — no separate mechanism.
//
// CALL SITE (updated): the ask now renders into home.html's
// #notify-card-slot (rehomed from processing.html's old #push-ask-slot),
// shown to every logged-in home visitor via refreshNotifyCard rather than
// only during a generation — see home.html's ORPHAN (a) block. That is the
// one caller in this codebase; the iOS-fallback chaining below applies
// there identically.
window.PushSubscribe = (function () {
  /** Fire-and-forget PostHog capture, same guarded shape every other page-local track() helper in this codebase uses. */
  function track(name, props) {
    if (window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  /** Standard base64url -> Uint8Array conversion for PushManager.subscribe's applicationServerKey — every Web Push integration needs this exact conversion (VAPID public keys are base64url-encoded; the Push API wants raw bytes). */
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function isSupported() {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
      typeof window !== 'undefined' && 'PushManager' in window &&
      typeof Notification !== 'undefined';
  }

  /**
   * Actually subscribes (assumes permission is already 'granted' — see
   * maybeShowAsk below, the only real caller) and persists the
   * subscription server-side. Idempotent: if this browser already has a
   * live subscription (e.g. a second call on a later page load, or a
   * retry), reuses it via getSubscription() rather than minting a
   * redundant second one — pushManager.subscribe() with the SAME
   * applicationServerKey is itself idempotent per spec, but checking
   * first avoids an unnecessary round trip. Always re-POSTs to
   * save-push-subscription.js even for an already-existing subscription
   * — cheap, and self-heals a case where the subscription exists
   * client-side but the earlier server-side save failed (see that
   * store's own doc comment on why this is safe/idempotent there too).
   */
  function subscribe(username) {
    if (!isSupported() || !username) return Promise.resolve({ ok: false, error: 'unsupported_or_no_username' });
    return navigator.serviceWorker.ready.then(function (registration) {
      return registration.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing;
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      });
    }).then(function (subscription) {
      var json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription;
      return fetch('/.netlify/functions/save-push-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, subscription: json })
      }).then(function (res) { return res.json(); }).then(function (data) {
        return { ok: !!(data && data.ok) };
      });
    }).catch(function (e) {
      return { ok: false, error: (e && e.message) || 'subscribe_failed' };
    });
  }

  function shouldShowAsk() {
    if (!isSupported()) return false;
    if (!window.DreamStore) return false;
    if (DreamStore.detectInAppWebviewHost()) return false; // see header comment -- standing rule
    if (Notification.permission !== 'default') return false; // already answered, one way or the other
    if (DreamStore.getPushAskDismissed()) return false;
    return true;
  }

  /**
   * True specifically when push is unsupported BECAUSE this is an iOS/
   * iPadOS Safari-family browser TAB (not installed to the home screen) —
   * Apple only ever exposes PushManager to an installed home-screen web
   * app, never to an ordinary tab, on any iOS browser (Safari, Chrome-iOS,
   * Firefox-iOS all share the same WebKit-enforced restriction — matches
   * PwaInstall.isIOS's own doc comment on checking the OS, not the
   * specific browser chrome). Deliberately narrow: this is false for a
   * desktop browser that simply lacks Push API support, or any other
   * unsupported reason — only THIS one case gets the fallback message
   * below (see this file's 2026-07-29 header note); every other
   * unsupported case stays exactly as silent as before.
   */
  function isIOSBrowserTabUnsupported() {
    if (!window.PwaInstall || typeof PwaInstall.isIOS !== 'function') return false;
    if (!PwaInstall.isIOS()) return false;
    return !PwaInstall.isStandalone();
  }

  function shouldShowIOSFallback() {
    if (isSupported()) return false; // push genuinely works here -- always prefer the real ask over the fallback
    if (!window.DreamStore) return false;
    if (DreamStore.detectInAppWebviewHost()) return false; // same standing rule as the real ask
    if (!isIOSBrowserTabUnsupported()) return false; // only this one unsupported reason gets a fallback
    if (DreamStore.getPushAskDismissed()) return false; // same one-ever marker -- dismissing either version means never ask again in this browser
    return true;
  }

  /**
   * Renders the real "Notify me" ask card into `containerEl` for
   * `username` (the currently signed-in account). Assumes shouldShowAsk()
   * has already been checked by the caller (maybeShowAsk below).
   */
  function renderRealAsk(containerEl, username) {
    var card = document.createElement('div');
    card.className = 'push-ask-card';
    card.id = 'push-ask-card';
    card.innerHTML =
      '<button type="button" class="push-ask-x" id="push-ask-dismiss" aria-label="Dismiss">&times;</button>' +
      '<div class="push-ask-head"><span class="push-ask-dot">' + (window.Icons ? Icons.bell : '') + '</span><span>Get notified when it\'s ready</span></div>' +
      '<div class="push-ask-body">Video generation takes a minute or two — we\'ll let you know the instant your dream is done.</div>' +
      '<button type="button" class="push-ask-btn" id="push-ask-enable">Notify me <span class="icon">' + (window.Icons ? Icons.bell : '') + '</span></button>';
    containerEl.innerHTML = '';
    containerEl.appendChild(card);

    track('push_prompt_shown', {});

    document.getElementById('push-ask-dismiss').addEventListener('click', function () {
      DreamStore.dismissPushAsk();
      card.remove();
    });

    document.getElementById('push-ask-enable').addEventListener('click', function () {
      Notification.requestPermission().then(function (permission) {
        DreamStore.dismissPushAsk(); // asked-and-answered either way -- never ask again in this browser
        if (permission === 'granted') {
          track('push_prompt_granted', {});
          subscribe(username);
        } else {
          track('push_prompt_denied', {});
        }
        card.remove();
      }).catch(function () {
        card.remove();
      });
    });
  }

  /**
   * Renders the iOS-browser-tab fallback chain into `containerEl` — see
   * this file's 2026-07-29 header note. "See how" expands the SAME iOS
   * guidance js/install-nudge.js's own small card renders
   * (InstallNudge.buildIOSGuidanceHtml), directly in place, rather than
   * navigating away or duplicating that markup a second time. Assumes
   * shouldShowIOSFallback() has already been checked by the caller.
   */
  function renderIOSFallback(containerEl) {
    var card = document.createElement('div');
    card.className = 'push-ask-card';
    card.id = 'push-ask-card';
    card.innerHTML =
      '<button type="button" class="push-ask-x" id="push-ask-dismiss" aria-label="Dismiss">&times;</button>' +
      '<div class="push-ask-head"><span class="push-ask-dot">' + (window.Icons ? Icons.bell : '') + '</span><span>Get notified when it\'s ready</span></div>' +
      '<div class="push-ask-body">Notifications need the installed app on iOS — want to be told the instant your dream is ready? Add DreamTube to your home screen.</div>' +
      '<button type="button" class="push-ask-btn" id="push-ask-install-cta">See how <span class="icon">' + (window.Icons ? Icons.shareIos : '') + '</span></button>' +
      '<div id="push-ask-install-guidance" style="display:none; margin-top:10px;"></div>';
    containerEl.innerHTML = '';
    containerEl.appendChild(card);

    track('push_fallback_shown', {});

    document.getElementById('push-ask-dismiss').addEventListener('click', function () {
      DreamStore.dismissPushAsk();
      card.remove();
    });

    document.getElementById('push-ask-install-cta').addEventListener('click', function () {
      track('push_fallback_install_cta_tapped', {});
      var guidance = document.getElementById('push-ask-install-guidance');
      guidance.innerHTML = (window.InstallNudge && typeof InstallNudge.buildIOSGuidanceHtml === 'function')
        ? InstallNudge.buildIOSGuidanceHtml()
        : '<div class="push-ask-body">Tap the Share icon, then scroll down and look for "Add to Home Screen."</div>';
      guidance.style.display = '';
      this.style.display = 'none';
    });
  }

  /**
   * Renders whichever ask is actually appropriate into `containerEl` (an
   * existing, empty element on the page — processing.html provides
   * #push-ask-slot) for `username` (the currently signed-in account): the
   * real "Notify me" ask when push genuinely works here (shouldShowAsk),
   * the iOS-browser-tab fallback chain when it specifically can't for
   * that one reason (shouldShowIOSFallback), or a silent no-op for every
   * other case — unchanged from this function's original behavior.
   */
  function maybeShowAsk(containerEl, username) {
    if (!containerEl) return;
    if (shouldShowAsk()) { renderRealAsk(containerEl, username); return; }
    if (shouldShowIOSFallback()) { renderIOSFallback(containerEl); return; }
  }

  return {
    isSupported: isSupported,
    subscribe: subscribe,
    maybeShowAsk: maybeShowAsk,
    isIOSBrowserTabUnsupported: isIOSBrowserTabUnsupported
  };
})();
