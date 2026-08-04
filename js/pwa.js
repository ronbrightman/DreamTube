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
//
// A third job, added for tracker item for-product-a2hs-install-nudge-3-
// founder-vcofk7 (the A2HS nudge's "one-shot disappearance" fix):
// verifying real install completion for home.html's persistent journey
// card. Two independent signals both call DreamStore.markInstallVerified()
// (see that function's own doc comment in js/store.js): this exact page
// loading in `display-mode: standalone` for a signed-in account, and
// Android's `appinstalled` event actually firing.
window.PwaInstall = (function () {
  var deferredPrompt = null;
  var installedFlag = false;

  /**
   * Fires DreamStore.markInstallVerified() for the CURRENTLY signed-in
   * account — the real, verified completion signal for the homepage A2HS
   * journey card (tracker item for-product-a2hs-install-nudge-3-founder-
   * vcofk7's "one-shot disappearance" fix, home.html's persistent
   * next-step card). Guarded defensively (no-op, never throws) same as
   * every other PWA-adjacent call in this file — store.js loads before
   * this script on every real page (see CLAUDE.md's script-order
   * convention) and reads its persisted state synchronously at parse
   * time, so DreamStore.getCurrentUser() already reflects a real signed-in
   * session here if one exists, but this stays defensive anyway since
   * markInstallVerified is safe to call speculatively either way.
   *
   * `source` (added for tracker item for-product-install-first-door-
   * founder-d-b60cls, the retention-sprint "install-verified rate"
   * scoreboard number) is passed straight through to
   * DreamStore.markInstallVerified(source), the layer that actually fires
   * the install_verified PostHog event — see that function's own doc
   * comment in js/store.js.
   */
  function markInstallVerifiedIfSignedIn(source) {
    try {
      if (!window.DreamStore || typeof DreamStore.markInstallVerified !== 'function') return;
      if (!DreamStore.getCurrentUser || !DreamStore.getCurrentUser()) return;
      DreamStore.markInstallVerified(source);
    } catch (e) { /* must never break the page */ }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      // Review finding, tracker item for-product-a2hs-install-nudge-3-
      // founder-vcofk7: beforeinstallprompt is async and heuristic-gated
      // (Chrome doesn't always fire it immediately on page load), so
      // home.html's persistent #card-install journey card -- which computes
      // its own visibility synchronously on load, before this event may
      // have fired -- could stay wrongly hidden for an entire page view
      // with no way to reconcile. Dispatching a real DOM event here lets
      // that card (or anything else caring about install-capability
      // changing mid-load) react the moment a real prompt actually becomes
      // available, rather than only ever re-checking on the later
      // appinstalled event.
      window.dispatchEvent(new CustomEvent('dreamtube:install-capability-changed'));
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      installedFlag = true;
      // Android's appinstalled is itself a real, non-guessable completion
      // signal (Chrome only ever fires it once the install has actually
      // finished) — worth marking right away rather than waiting for this
      // same account's next standalone-mode page load to catch it via the
      // isStandalone() check below.
      markInstallVerifiedIfSignedIn('appinstalled');
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

  /** True on an iOS/iPadOS Safari-family browser — the one platform that can NEVER fire beforeinstallprompt, so the install nudge must fall back to manual "tap Share -> Add to Home Screen" instructions there instead of a real native prompt. True for Chrome-on-iOS/Firefox-on-iOS too (they use Apple's forced WebKit engine and also can't show a native prompt) — this just checks the OS, not the specific browser chrome; see iosBrowserKind() below for the browser-specific distinction the actual on-screen guidance needs. */
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (ua.indexOf('Macintosh') !== -1 && navigator.maxTouchPoints > 1);
  }

  /**
   * True on an Android device (any browser) — same plain-UA-token
   * convention as isIOS() above, and the same detection processing.html's
   * own private isAndroidUA() already used for the webview-escape Android
   * intent:// path (that one stays page-local, this is the one other
   * callers — js/install-nudge.js's Step 2 install moment — need). Added
   * for tracker item for-product-install-first-door-founder-d-b60cls:
   * Android without a captured beforeinstallprompt (Chrome can be slow or
   * heuristic-gated about firing it, and other Android browsers never fire
   * it at all) still needs a real "look in your browser's menu" fallback at
   * the guided Step 2 moment, rather than silently offering nothing — see
   * js/install-nudge.js's hasSomethingToOfferForStep2().
   */
  function isAndroid() {
    return /Android/.test(navigator.userAgent || '');
  }

  /**
   * Which iOS browser chrome is actually showing this page — added for
   * tracker item for-product-bug-research-founder-high-ad-vnda9t (the
   * founder's own real-device report: A2HS "doesn't even appear" in
   * Chrome). Research finding (verified at-source, not from memory — see
   * that item's own resolution): every iOS browser runs on Apple's forced
   * WebKit engine, so isIOS() above is still right that none of them can
   * ever fire beforeinstallprompt — but the ACTUAL on-screen path to "Add
   * to Home Screen" is NOT identical across them the way this file used to
   * assume. Safari's real toolbar is a "•••" More button (bottom-right)
   * opening a small menu with Share as its first item; Chrome's is a
   * direct Share icon at the right of its address bar (Google's own
   * support doc: https://support.google.com/chrome/answer/9658361).
   * Third-party iOS browsers each opt into Apple's own
   * SFAddToHomeScreenActivityItem system-share-sheet API independently —
   * Chrome added this around July 2023 and it's still current for
   * 2025/2026, confirmed via Google's own support page — but nothing
   * guarantees every browser's menu surfaces the action identically or
   * even reliably (real, unresolved Apple Community / Google Chrome
   * Community reports of Chrome's share sheet needing a one-time "Edit
   * Actions" step before "Add to Home Screen" appears at all are common).
   * Detected via each vendor's own well-established iOS user-agent token
   * (CriOS/FxiOS/EdgiOS/OPiOS — the same convention every vendor already
   * uses to identify itself on iOS, not a guess) so js/install-nudge.js's
   * guidance can show ONLY what's actually achievable for the browser in
   * front of the visitor right now, per this app's standing no-fake-
   * buttons discipline — never Safari's specific "•••" mock to a Chrome
   * user, who has no such button in that place.
   */
  function iosBrowserKind() {
    var ua = navigator.userAgent || '';
    if (/CriOS/.test(ua)) return 'chrome';
    if (/FxiOS/.test(ua)) return 'firefox';
    if (/EdgiOS/.test(ua)) return 'edge';
    if (/OPiOS/.test(ua)) return 'opera';
    return 'safari'; // default -- real Safari, and any iOS browser/webview with no other vendor's own UA token
  }

  // ==========================================================================
  // Stale-page-after-deploy fix (tracker item for-product-urgent-founder-
  // gets-stale-pa-6dn54z). Root-caused via two DISTINCT gaps that both
  // needed closing — neither one alone explains the founder's reported
  // symptom (home.html showing the pre-deploy version a full 2 hours after
  // a fresh deploy, on real iPhone Safari, fixed only by a private tab or
  // closing all tabs):
  //
  //   Gap 1 — this file never called `registration.update()` or listened
  //   for `controllerchange`. Without an explicit update() call, an update
  //   check relies entirely on the browser's own background timing (the
  //   spec allows throttling this to once per 24h; iOS Safari in
  //   particular is long-documented as lazy/inconsistent about it). And
  //   even once a new worker genuinely installs+activates+claims,
  //   clients.claim() only changes which worker handles FUTURE fetches
  //   from an already-open tab — it does not touch what's already
  //   rendered in that tab's DOM, since this is a no-build-step app whose
  //   pages carry real per-deploy logic in their own inline <script>
  //   blocks (see CLAUDE.md), not just static markup.
  //
  //   Gap 2 — the actually dominant one for THIS reported symptom. sw.js's
  //   own navigation handling is already network-first (see that file's
  //   header comment) and Netlify's cache-control headers were confirmed
  //   correct — so an ordinary reload or fresh navigation already gets a
  //   fresh copy of a changed page regardless of the service worker's own
  //   update lifecycle above (which only ever matters when sw.js's OWN
  //   bytes change between deploys — a rare event; most deploys only
  //   touch page HTML/CSS/JS, never sw.js). The reported "2 hours later"
  //   sequence has no reload in it at all: iOS Safari can keep a
  //   backgrounded tab's web content process alive-but-frozen (JS
  //   execution paused, DOM untouched) for a long time without ever
  //   re-navigating, distinct from the bfcache/back-forward case this
  //   codebase already handles elsewhere (see processing.html's pagehide
  //   comments) — no `pageshow` fires for this, only `visibilitychange`,
  //   since nothing is being restored from history, it simply never left.
  //   Reopening that same tab replays the exact frozen page with no
  //   network request of any kind, so no caching layer -- HTTP or SW --
  //   ever gets a chance to matter. This is exactly what "close all tabs /
  //   open a private tab" works around: both force Safari to actually
  //   tear down and recreate the process, i.e. a real navigation.
  //
  // Fix: force a real SW update check AND a real page reload whenever this
  // tab becomes visible again after sitting hidden for a while — the one
  // moment guaranteed to fire (visibilitychange) even when no navigation
  // ever happens on its own.
  //
  // Review round 1 finding, fixed: the typing guard below originally only
  // checked document.activeElement, missing create.html's Record mode
  // entirely -- a plain button starts navigator.mediaDevices.getUserMedia
  // + MediaRecorder there, with the in-progress audio held ONLY in an
  // in-memory recordedChunks array (never persisted to state.draft/
  // localStorage until the user stops and it's transcribed), and nothing
  // on that page paused/stopped the recorder on visibilitychange. A tab
  // backgrounded mid-recording would have force-reloaded straight through
  // it, silently losing the recording -- the exact same class of data
  // loss the typing guard already existed to prevent, just for a third
  // input modality (write/build/record) on the same page this file had no
  // visibility into. Fixed via registerBusyCheck() below: a small
  // registry any page can push an "am I busy right now" predicate into,
  // rather than hardcoding create.html-specific knowledge into this file
  // (no existing cross-file "is something busy" convention was found
  // elsewhere in this codebase to reuse instead — checked first).
  //
  // Review round 1 non-blocking note, acknowledged rather than fixed:
  // result.html/explore.html each have their own visibilitychange
  // listener that smoothly resumes paused video/audio playback on
  // foreground; this file's own visibilitychange listener (registered
  // first, per this app's store.js-then-pwa.js-then-page-script load
  // order) can force a reload before that resume logic runs, abruptly
  // restarting playback rather than resuming it. Accepted tradeoff, not
  // fixed here: clips are short (4-8s) and this only happens at all once
  // a tab has already sat hidden past the 30-minute threshold, at which
  // point getting the tab onto the current deploy outweighs a few
  // seconds of restarted-instead-of-resumed playback.
  //
  // Review round 2 finding, fixed: round 1's fix deferred a reload while
  // Record mode was busy, but the ONLY recheck triggers were
  // visibilitychange/focusout — and create.html's #stop-record handler
  // never focuses/blurs anything itself. WebKit (Safari, the exact
  // platform this whole bug is about) deliberately does not give a
  // <button> focus on click the way Chromium does, so hiding
  // #create-record after a recording stops produces no focusout at all on
  // Safari — a reload deferred during recording could sit deferred
  // indefinitely after it safely stopped. Fixed via recheckBusy() below:
  // create.html now calls it directly the moment mediaRecorder.state
  // genuinely flips to 'inactive', driven by the real state transition
  // that matters rather than an incidental focus side effect Safari
  // doesn't reliably produce. NOTE ON TEST COVERAGE: this file's test
  // suite only runs against Chromium (no WebKit engine is configured
  // anywhere in test/ — checked), and Chromium DOES focus a <button> on
  // click, so no test here can actually reproduce the Safari-specific gap
  // itself; the regression test added for this fix instead exercises
  // recheckBusy() directly (simulating "recording stopped, nothing
  // focused/blurred") rather than claiming to prove the real Safari case.
  // ==========================================================================

  /**
   * A small registry any page can push an "am I busy right now" check
   * into, so reloadWhenSafe() below can defer for a page-specific reason
   * this file has no built-in knowledge of (e.g. create.html's Record
   * mode — see header comment) without hardcoding that page's internals
   * here. Each registered function is called defensively (never allowed
   * to throw out into the caller) and OR'd together — busy if ANY of them
   * say so. Deliberately not gated behind anything test-only: any real
   * page is free to call this today, not just tests.
   */
  var busyChecks = [];
  function registerBusyCheck(fn) {
    if (typeof fn === 'function') busyChecks.push(fn);
  }

  /** How long a tab must have been hidden before becoming visible again is treated as "possibly stale, worth a real reload" — short backgrounding (switching apps for a few seconds, an incoming call) shouldn't force a reload of a page someone is actively using; the founder's reported gap was measured in hours, not seconds. Overridable by test/pwa-sw-update-behavioral.test.js via window.__TEST_PWA_OVERRIDES__.hiddenStaleThresholdMs, same override-object convention js/purchase-sheet.js's pollForCredit already uses for its own real-but-slow timing. */
  var HIDDEN_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  function hiddenStaleThresholdMs() {
    var overrides = (typeof window !== 'undefined' && window.__TEST_PWA_OVERRIDES__) || {};
    return typeof overrides.hiddenStaleThresholdMs === 'number' ? overrides.hiddenStaleThresholdMs : HIDDEN_STALE_THRESHOLD_MS;
  }

  /** True while the user looks to be actively entering text right now — one of two things worth deferring an otherwise-safe reload for (see isPageBusy() below). Deliberately generic (checks the focused element, not any one page's specific state) so this file doesn't need per-page knowledge of every form. */
  function isEditingSomething() {
    try {
      var el = document.activeElement;
      if (!el) return false;
      var tag = (el.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
    } catch (e) {
      return false;
    }
  }

  /** True if this page is busy in ANY way worth deferring an otherwise-safe reload for right now — actively being typed into (isEditingSomething), or busy per any page-registered registerBusyCheck() predicate (e.g. create.html's Record mode). Each registered check is called defensively; one throwing must never block the others or crash the caller. */
  function isPageBusy() {
    if (isEditingSomething()) return true;
    for (var i = 0; i < busyChecks.length; i++) {
      try {
        if (busyChecks[i]()) return true;
      } catch (e) { /* a broken registered check must never block a real reload */ }
    }
    return false;
  }

  var reloadOnceGuard = false;
  var reloadDeferredPending = false; // true once reloadWhenSafe() has been called at least once and is still waiting on a busy page -- see attempt()/recheckBusy() below

  /**
   * Shared by reloadWhenSafe() and recheckBusy() below — re-checks
   * isPageBusy() and reloads if it's now false, no-ops otherwise. Guarded
   * by reloadDeferredPending so a recheckBusy() call is a safe no-op
   * unless reloadWhenSafe() has actually been called at least once (a page
   * that never had a reload requested shouldn't have one forced into
   * existence just because something called "recheck now").
   */
  function attempt() {
    if (reloadOnceGuard) return;
    if (!reloadDeferredPending) return;
    if (isPageBusy()) return; // still busy -- wait for the next signal (visibilitychange/focusout, or an explicit recheckBusy() call)
    reloadOnceGuard = true;
    document.removeEventListener('visibilitychange', attempt);
    document.removeEventListener('focusout', attempt);
    try {
      location.reload();
    } catch (e) { /* must never throw out of an event handler */ }
  }

  /**
   * Reloads the page exactly once (module-level guard — both callers below
   * share it, since controllerchange can in principle fire more than once
   * across a page's lifetime and both triggers ultimately want the same
   * "get this tab onto the current deploy" outcome). Never interrupts a
   * busy page (isPageBusy() above — actively typing, or a registered
   * page-specific busy check): defers and re-checks on the next
   * visibilitychange, focusout, or explicit recheckBusy() call, rather
   * than force-reloading straight through a draft in create.html/
   * wizard.html or an in-progress Record mode recording. Every other page
   * (including processing.html's generation wait) is safe to reload
   * outright — generation state is already persisted server-side / in
   * state.pendingJob (see js/store.js), not held only in memory.
   *
   * Review round 2 finding, fixed: this used to rely ONLY on
   * visibilitychange/focusout to re-check after a deferred reload — but
   * create.html's #stop-record click handler never focuses/blurs anything
   * itself, and WebKit (Safari, the exact platform this whole bug is
   * about) deliberately does NOT give a <button> focus on click/tap the
   * way Chromium does, so hiding #create-record after a recording stops
   * produced no focusout on Safari at all. A reload deferred during
   * recording could sit deferred indefinitely after it safely stopped,
   * until some unrelated later event happened to trigger a recheck.
   * create.html now calls PwaInstall.recheckBusy() directly from the
   * moment mediaRecorder.state genuinely flips to 'inactive' (the actual
   * state transition that matters), rather than depending on an
   * incidental focus-event side effect Safari doesn't reliably produce.
   */
  function reloadWhenSafe() {
    if (reloadOnceGuard) return;
    // Attached at most once per page load, even across multiple deferred
    // attempts (e.g. two separate hidden->visible cycles while the same
    // draft/recording is still in progress) -- a second reloadWhenSafe()
    // call while one is already pending would otherwise stack a redundant,
    // never-cleaned-up listener pair each time (harmless in practice since
    // reloadOnceGuard still caps it to one real reload, but needless).
    if (!reloadDeferredPending) {
      reloadDeferredPending = true;
      document.addEventListener('visibilitychange', attempt);
      document.addEventListener('focusout', attempt);
    }
    attempt();
  }

  /**
   * Lets a page tell js/pwa.js "something that might have been blocking a
   * deferred reload just changed, recheck now" — the fix for the
   * WebKit/Safari focus gap documented on reloadWhenSafe() above. A safe
   * no-op if no reload was ever actually deferred (reloadDeferredPending
   * false) or one already happened (reloadOnceGuard true), so any page is
   * free to call this defensively/speculatively without risk of forcing a
   * reload into existence that was never otherwise requested.
   */
  function recheckBusy() {
    attempt();
  }

  // ==========================================================================
  // Second, SW-lifecycle-INDEPENDENT safety net (further round of tracker
  // item for-product-urgent-founder-gets-stale-pa-6dn54z, 2026-08-04). The
  // CACHE_VERSION auto-stamping fix above is confirmed live and correct on
  // both production origins (verified via live curl against dreamtube1.
  // netlify.app and dreamtube.life immediately before this was written), but
  // it only ever reaches a DEVICE that already has an old service worker
  // registered from before that fix existed if the browser's own
  // `registration.update()` byte-comparison check succeeds at least once —
  // and that check is specifically unreliable in Safari/WKWebView, the
  // founder's actual real-world browsing context (iOS Safari, Facebook/
  // Instagram in-app webviews). So the entire recovery path above depends on
  // the very mechanism that's known to be flaky there. This is a second,
  // completely independent layer that never touches the service worker at
  // all: a plain page-level fetch of /version.json (already written at
  // build time by scripts/generate-version.js — see that file), compared
  // against the last version this exact browser saw, stored in localStorage.
  // A genuine mismatch reuses reloadWhenSafe() above verbatim — same
  // one-shot guard, same typing/recording busy check — rather than a second,
  // weaker reload path that could stomp a draft or an in-progress recording.
  //
  // Runs (1) once immediately on this page load, and (2) reusing the exact
  // same hiddenStaleThresholdMs()-gated visibilitychange pattern
  // registerServiceWorker() already uses for its own hidden-tab check below
  // — deliberately the SAME threshold/timing scheme, not a second one, per
  // this fix's own brief. This listener is attached unconditionally,
  // independent of whether navigator.serviceWorker even exists or
  // registration succeeds, which is the whole point: it must keep working
  // even when the service worker layer is completely broken or absent.
  // ==========================================================================

  /** localStorage key holding the last version.json "version" string this browser has observed — same dreamtube_*_v1 naming convention js/store.js's own keys use (see e.g. LIKES_SEEN_KEY, PERSIST_ASKED_KEY). */
  var LAST_KNOWN_VERSION_KEY = 'dreamtube_last_known_version_v1';

  /**
   * Compares `version` (a freshly-fetched version.json "version" string)
   * against whatever this browser last recorded. Three outcomes:
   *   - Nothing recorded yet (brand new browser/first-ever check here):
   *     just record it, no reload — matches the existing controllerchange-
   *     on-first-load guard's own reasoning (a new visitor shouldn't get a
   *     pointless reload).
   *   - Recorded value matches: no-op, this browser is already current.
   *   - Recorded value differs: record the new value, then trigger the
   *     shared reloadWhenSafe() deferred reload — the real "stale content"
   *     signal this whole mechanism exists to catch.
   * Defensive: a localStorage read/write failure (private mode, storage
   * disabled) is swallowed and treated as "can't safely compare," same
   * discipline as every other localStorage access in this codebase — never
   * throws, never breaks the page.
   */
  function recordVersionAndReloadIfChanged(version) {
    if (typeof version !== 'string' || !version) return;
    var previous;
    try {
      previous = localStorage.getItem(LAST_KNOWN_VERSION_KEY);
    } catch (e) {
      return; // can't safely read -- don't guess, don't reload
    }
    if (previous === version) return; // already current, nothing to do
    try {
      localStorage.setItem(LAST_KNOWN_VERSION_KEY, version);
    } catch (e) {
      return; // can't safely record the new value -- skip the reload too, rather than risk reloading every single check from here on with nothing ever successfully recorded
    }
    if (previous === null) return; // first-ever check for this browser -- just recorded a baseline, no reload
    reloadWhenSafe(); // a real, later mismatch -- the actual stale-content signal
  }

  /**
   * Fetches version.json fresh (cache: 'no-store', same as admin.html's and
   * media-library-x7q4.html's existing version-line readers — established
   * precedent in this codebase, not a new pattern) and hands the result to
   * recordVersionAndReloadIfChanged(). Best-effort everywhere: a failed
   * fetch, a non-ok response, or malformed JSON all resolve quietly with no
   * reload and no error thrown — matches this file's own registerServiceWorker()
   * try/catch discipline for every other analytics/PWA-adjacent call.
   * Returns a Promise that always resolves (never rejects) once settled, so
   * callers (and tests) can await "this check has finished" deterministically.
   */
  function checkVersionFallback() {
    try {
      return fetch('/version.json', { cache: 'no-store' }).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (data) {
        if (data && typeof data.version === 'string') recordVersionAndReloadIfChanged(data.version);
      }).catch(function () { /* fetch failure, non-JSON body, etc -- must never break the page */ });
    } catch (e) {
      return Promise.resolve(); // synchronous throw (e.g. fetch unavailable at all) -- same defensive discipline
    }
  }

  /**
   * Resolves once the page-load-time checkVersionFallback() call below has
   * settled — exposed purely so test/pwa-version-fallback-behavioral.test.js
   * can await a real, precise readiness signal instead of guessing at a
   * fixed delay, same reasoning as swListenersReady above. Never awaited by
   * any real page; harmless to leave in place for production loads.
   */
  var versionFallbackReadyResolve = null;
  var versionFallbackReady = new Promise(function (resolve) { versionFallbackReadyResolve = resolve; });

  function initVersionFallback() {
    checkVersionFallback().then(versionFallbackReadyResolve);

    // Same hiddenStaleThresholdMs()-gated visibilitychange pattern as
    // registerServiceWorker()'s own hidden-tab check — separate bookkeeping
    // (this listener is attached unconditionally, independent of whether
    // that other one ever gets attached at all) but the SAME threshold
    // function/override, per this fix's own brief not to invent a second
    // timing scheme.
    var hiddenAtMs = null;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        hiddenAtMs = Date.now();
        return;
      }
      if (document.visibilityState !== 'visible') return;
      if (hiddenAtMs !== null && (Date.now() - hiddenAtMs) >= hiddenStaleThresholdMs()) {
        checkVersionFallback();
      }
      hiddenAtMs = null;
    });
  }

  /**
   * Resolves once registerServiceWorker()'s own registration.then() below
   * has finished attaching its controllerchange/visibilitychange listeners
   * -- exposed on the PwaInstall object purely so
   * test/pwa-sw-update-behavioral.test.js can await a real, precise
   * readiness signal instead of guessing at a fixed delay. That guess
   * (waiting for navigator.serviceWorker.controller to be truthy, plus a
   * fixed buffer) is exactly what made that test suite genuinely flaky --
   * confirmed directly by running the same scenario standalone many times
   * over and watching it occasionally miss the window -- since how long
   * after `controller` becomes non-null this same .then() callback
   * actually runs is real, variable async scheduling, not a fixed
   * duration. Never awaited by any real page; harmless to leave in place
   * for production loads.
   */
  var swListenersReadyResolve = null;
  var swListenersReady = new Promise(function (resolve) { swListenersReadyResolve = resolve; });

  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Service Worker registration itself throws for a non-http(s) origin
    // (e.g. this repo's pages opened directly via file:// during ad hoc
    // local testing, or Playwright's file:// fallback) — guard explicitly
    // rather than relying solely on the try/catch below, since some
    // engines reject the registration Promise asynchronously in a way a
    // bare .catch still handles fine, but this is cheap and avoids even
    // attempting a call that's guaranteed to fail.
    if (location.protocol !== 'http:' && location.protocol !== 'https:') { swListenersReadyResolve(); return; }
    try {
      navigator.serviceWorker.register('sw.js').then(function (registration) {
        if (!registration) { swListenersReadyResolve(); return; }

        // Gap 1's fix, part A: force a real byte-comparison update check
        // right now, rather than relying solely on the browser's own
        // (possibly 24h-throttled) background timing.
        registration.update().catch(function () { /* best-effort -- never break the page */ });

        // Gap 1's fix, part B: once a new worker this registration
        // controls actually takes over, get this tab onto the deploy it
        // just activated, subject to reloadWhenSafe's typing guard above.
        //
        // Caught by this file's own test suite, NOT by manual testing --
        // real proof this needed the guard below, not just theory: a
        // controllerchange also fires the very FIRST time this tab ever
        // gets a controller at all (an uncontrolled client transitioning
        // to controlled the moment clients.claim() runs during this SW's
        // first-ever activate for this tab) -- that's not a stale-content
        // signal, it's just this exact page load's own service worker
        // finishing its normal first-time setup, and reloading for it
        // would force EVERY new visitor through a pointless extra reload
        // on their very first page view. Only a controller actually being
        // REPLACED (this tab already had one, and it just changed) is the
        // real "a new deploy took over -- refresh" signal worth acting on.
        var hadControllerAlready = !!navigator.serviceWorker.controller;
        if (navigator.serviceWorker.addEventListener) {
          navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (!hadControllerAlready) {
              hadControllerAlready = true; // first assignment, not a replacement -- ignore this once, then treat any later change as real
              return;
            }
            reloadWhenSafe();
          });
        }

        // Gap 2's fix: re-check for a real update AND force a full reload
        // every time this tab becomes visible again after being hidden
        // long enough to plausibly be stale — the one signal guaranteed to
        // fire even when a frozen background tab never issues a fresh
        // navigation/fetch of its own accord (see header comment above).
        var hiddenAtMs = null;
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') {
            hiddenAtMs = Date.now();
            return;
          }
          if (document.visibilityState !== 'visible') return;

          registration.update().catch(function () { /* best-effort */ });

          if (hiddenAtMs !== null && (Date.now() - hiddenAtMs) >= hiddenStaleThresholdMs()) {
            reloadWhenSafe();
          }
          hiddenAtMs = null;
        });

        swListenersReadyResolve();
      }).catch(function () {
        // Registration can legitimately fail (unsupported context, a
        // restrictive browser setting) -- this must never break the page
        // it's loaded from.
        swListenersReadyResolve();
      });
    } catch (e) {
      // same discipline as every other analytics/PWA-adjacent call in this codebase -- must never break the app
      swListenersReadyResolve();
    }
  }

  registerServiceWorker();
  initVersionFallback();

  // Real, verified "opened from the home screen" signal — fires at most
  // once per account (markInstallVerified is itself idempotent) on
  // whichever page happens to load first in standalone mode, not just
  // home.html, per this item's own spec ("the first time home.html — or
  // any page — loads in standalone mode for a signed-in user"). Cheap
  // no-op on every ordinary browser-tab load, the overwhelming majority.
  if (isStandalone()) markInstallVerifiedIfSignedIn('standalone_load');

  return {
    canPromptInstall: canPromptInstall,
    promptInstall: promptInstall,
    isStandalone: isStandalone,
    isIOS: isIOS,
    isAndroid: isAndroid,
    iosBrowserKind: iosBrowserKind,
    registerBusyCheck: registerBusyCheck,
    recheckBusy: recheckBusy,
    __swListenersReady: swListenersReady,
    __versionFallbackReady: versionFallbackReady
  };
})();
