// js/push-subscribe.js
//
// Web Push subscribe flow — tracker item for-product-build-stage-0-pwa-
// web-push-f-jbutt5, part 3. Plain script (no ES modules — matches
// js/store.js's own convention, see CLAUDE.md), depends on js/pwa.js
// (service worker must already be registering) and js/push-config.js
// (VAPID_PUBLIC_KEY) both being loaded first.
//
// WHEN THIS ASKS (per this feature's own build task: "ask at a genuinely
// high-intent moment... never on page load, never as an unprompted
// popup"): processing.html calls maybeShowAsk() right after a first video
// starts generating — see that page's own call site for exactly where.
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
   * Renders the ask card into `containerEl` (an existing, empty element
   * on the page — processing.html provides #push-ask-slot) for
   * `username` (the currently signed-in account). No-ops entirely if
   * shouldShowAsk() is false — see that function for every gate.
   */
  function maybeShowAsk(containerEl, username) {
    if (!containerEl || !shouldShowAsk()) return;

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

  return { isSupported: isSupported, subscribe: subscribe, maybeShowAsk: maybeShowAsk };
})();
