// sw.js — DreamTube's service worker.
//
// Tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5 ("Stage 0"
// of a staged app-store plan: web push -> Play TWA -> iOS, founder-
// approved 2026-07-29 "I like starting small and easy"). This is the
// first service worker anywhere in this repo (confirmed via `find . -iname
// "sw.js" -o -iname "service-worker.js"` before writing this file) — no
// existing pattern to follow here, so the choices below are new and
// documented inline.
//
// SCOPE: registered at the site root ('/', see js/pwa.js's
// navigator.serviceWorker.register('sw.js') call — an unscoped register
// call defaults to the directory the SW file lives in, i.e. the whole
// site, since this file is at the repo root) — every page in this static
// multi-page app is covered by one worker, not one per page.
//
// CACHING STRATEGY — deliberately simple for a static, no-build-step,
// no-bundler multi-page site that deploys many times a day (see CLAUDE.md):
//   - Navigations (HTML page loads): NETWORK-FIRST, falling back to this
//     exact page's own last-cached copy if the network fails, and falling
//     back further to offline.html if there's no cached copy of THIS page
//     either (e.g. its very first visit, offline). Network-first (not
//     cache-first/stale-while-revalidate) is deliberate: this app's pages
//     embed inline <script> logic that changes on every deploy (this is
//     the whole app, not just static markup — see CLAUDE.md), so serving a
//     stale cached page while a fresher one is one network call away would
//     be a real regression, not just a minor staleness issue. The cache
//     here exists purely for the offline case, never to skip the network
//     when it's actually available.
//   - Static assets this app actually owns (css/js/assets/manifest.json —
//     NOT the fonts.googleapis.com/fonts.gstatic.com/i.posthog.com/
//     connect.facebook.net third-party requests every page also makes,
//     and NOT anything under /.netlify/functions/ or fal.ai's own media
//     CDN — see below): same network-first-with-cache-fallback shape,
//     for the same "never serve a stale copy of js/store.js — this app's
//     entire client-side backend — when a fresh one is reachable" reason.
//   - Everything else (POST requests, /.netlify/functions/* API calls,
//     cross-origin requests, fal.ai's generated video/image URLs) is left
//     completely alone — this worker does not intercept those requests at
//     all (no respondWith call for them), so the browser's own normal
//     network handling applies. Per this feature's own build task: never
//     cache generated video/image URLs — they're dynamic, per-dream, and
//     already served from fal.ai's own CDN with its own caching, not this
//     app's static shell.
//
// This is intentionally NOT an aggressive "app shell" precache of every
// HTML page (18+ pages, many with per-account/per-dream dynamic content
// baked into their initial render via inline <script> — there is no build
// step that produces a stable, cacheable shell distinct from the page
// itself). Only offline.html and a small set of top-level entry pages are
// precached at install time; everything else is cached opportunistically,
// the first time it's actually visited online, via the runtime fetch
// handler below.
//
// CACHE_VERSION / bump discipline (tracker item for-product-urgent-founder-
// gets-stale-pa-6dn54z): this only exists to name the runtime cache and
// know which old one(s) to delete in the activate handler below — it does
// NOT gate whether a page or static asset is served fresh (that's the
// network-first strategy above, unconditional). Its other real effect is
// that changing it changes this file's own bytes, which is what makes the
// browser notice sw.js itself has a new version worth installing (see
// js/pwa.js's registerServiceWorker() header comment on why that
// update-detection matters — a genuinely NEW controlling worker is what
// fires `controllerchange`, which forces an already-open tab to reload
// onto the new deploy).
//
// UPDATE (still tracker item 6dn54z, after two more founder-reported
// staleness incidents on 08-02/08-03 — AFTER the manual-bump version
// above had already shipped and been confirmed on-device once):
// manually bumping this string "whenever this file's own caching logic
// changes" meant sw.js's bytes stayed IDENTICAL across the vast majority
// of real deploys (routine page/content changes never touch this file),
// so `controllerchange` essentially never fired for those deploys — an
// already-open, never-backgrounded tab had no path back to the current
// deploy except the 30-minute-hidden visibilitychange fallback below, or
// manually closing/reopening the tab. This is now stamped automatically,
// every deploy, by scripts/generate-version.js (the ALREADY-EXISTING
// build-time script — see netlify.toml's `command = "npm run build"` —
// that stamps version.json with this exact same commit-based version
// string; tracker item for-product-release-visibility-founder-a-8hx5cz).
// Reusing that one mechanism rather than inventing a second means
// version.json's "version" field and this file's CACHE_VERSION are
// always identical for a given deploy — a direct, human-checkable way to
// confirm whether a given device's active service worker matches the
// currently deployed commit. See scripts/generate-version.js's own
// `stampServiceWorkerCacheVersion` for the exact substitution and
// test/generate-version.test.js for coverage of it.
//
// The literal value below is what a LOCAL/dev run (or any environment
// that never went through `npm run build`) sees — deliberately NOT a
// real version string, so it's obvious at a glance whether a given sw.js
// on disk has actually been through the real build step or not.
var CACHE_VERSION = 'v0-unbuilt-dev';
var CACHE_NAME = 'dreamtube-shell-' + CACHE_VERSION;

// Precached at install time — the minimum needed so a completely fresh
// install (before the runtime cache has anything in it yet) still has an
// offline fallback and can still open the app's real entry points offline.
// Deliberately small: this is a static multi-page site with no bundler, so
// there is no single "index bundle" to precache the way an SPA would —
// see header comment.
var PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './css/styles.css',
  './js/store.js',
  './js/icons.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function () {
      // Activate this new worker immediately rather than waiting for every
      // open tab of the old version to close — a static-site deploy this
      // frequent (see header comment) should take effect as soon as
      // possible, not linger on a stale worker for however long a tab
      // happens to stay open. The tradeoff (a page that was already open
      // before this install could, in principle, see a mixed set of
      // cached/fresh resources for one load) is acceptable here since the
      // caching strategy above is network-first everywhere that matters —
      // there is no correctness-sensitive resource this worker ever serves
      // stale over a reachable network.
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name.indexOf('dreamtube-shell-') === 0 && name !== CACHE_NAME;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/** True for a same-origin request this worker is willing to runtime-cache — this app's own static shell files, never a Netlify Function call, never a third-party host, never fal.ai's generated media. See header comment's caching-strategy section. */
function isCacheableStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.indexOf('/.netlify/functions/') === 0) return false;
  return (
    url.pathname === '/manifest.json' ||
    url.pathname.indexOf('/css/') === 0 ||
    url.pathname.indexOf('/js/') === 0 ||
    url.pathname.indexOf('/assets/') === 0
  );
}

/**
 * Network-first with a cache fallback, updating the cache on every successful
 * network response — shared shape for both navigations and static assets
 * below (they differ only in what they fall back to when there's no cached
 * copy at all).
 *
 * Forces `cache: 'no-store'` on the outbound fetch — added for tracker item
 * for-product-urgent-founder-gets-stale-pa-6dn54z's 08-02/08-03 recurrences,
 * which happened AFTER the visibilitychange/controllerchange fix (bae7969)
 * had already shipped and been confirmed on-device once. This function's own
 * logic was already correct by its own terms (re-confirmed by re-reading it
 * before touching it): it only ever falls back to a cached copy on a genuine
 * fetch() REJECTION, never on a received-but-possibly-stale response. What
 * it never controlled is whether the browser's own HTTP disk cache — a
 * completely separate layer beneath the Fetch API from this file's own Cache
 * Storage usage — gets consulted to satisfy that fetch() call at all. With
 * the default cache mode ('default', inherited from `request`), a fully
 * spec-compliant client honors this origin's own Cache-Control (confirmed
 * live: `public, max-age=0, must-revalidate`, which is correct and should
 * force revalidation on every access) — but this sandbox has no way to
 * verify a real iOS Safari/WebKit in-app-webview client actually implements
 * that correctly in every case, and the founder's own 08-02 report ("stale
 * through multiple hard reloads... and a different browser") reads exactly
 * like some client-side cache layer not honoring those headers the way this
 * function assumed. `no-store` removes the ambiguity outright: it skips the
 * HTTP cache entirely on the way out, so no code path here depends on that
 * layer behaving correctly, on any client.
 *
 * HONEST CAVEAT: this cannot be proven to be the exact root cause without a
 * real WebKit engine, which isn't available in this sandbox (Chromium only —
 * see test/sw-fetch-handler.test.js's own header comment). Treat this as
 * defense-in-depth for the most plausible remaining explanation, not a
 * confirmed device-level fix — per this item's own standing "don't overclaim
 * a device-level fix is proven" instruction.
 *
 * A Request constructed FROM another Request whose own `mode` is 'navigate'
 * (true for every page-navigation `request` this is called with) has its
 * mode downgraded to 'same-origin' by spec — a fresh Request can never
 * itself be constructed with mode 'navigate'. Harmless here: respondWith()
 * only cares about the RESPONSE this produces, not the mode of the request
 * used to fetch it. Falls back to fetching `request` completely unmodified
 * if this construction ever throws for any other reason, rather than
 * letting a defensive improvement break the request entirely.
 */
function networkFirst(request, offlineFallbackUrl) {
  var noStoreRequest;
  try {
    noStoreRequest = new Request(request, { cache: 'no-store' });
  } catch (e) {
    noStoreRequest = request;
  }
  return fetch(noStoreRequest).then(function (response) {
    // Only cache a genuinely successful, COMPLETE (status 200, never 206
    // Partial Content — the Cache Storage API spec disallows storing a
    // partial response and throws if you try) basic (same-origin,
    // non-opaque) response — never a 4xx/5xx, and never an opaque
    // cross-origin response this worker couldn't inspect anyway. Guarded
    // with its own .catch so a failed cache.put (e.g. a quota error) can
    // never surface as a broken response to the page — caching here is
    // always best-effort, the returned `response` below is what matters.
    if (response && response.status === 200 && response.type === 'basic') {
      var responseToCache = response.clone();
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.put(request, responseToCache);
      }).catch(function () { /* caching is best-effort -- must never break the real response */ });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      if (offlineFallbackUrl) return caches.match(offlineFallbackUrl);
      return undefined;
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  // Never intercept anything but a plain GET — POSTs (every Netlify
  // Function call this app makes) must always go straight to the network,
  // and the Cache API can't store a non-GET request anyway.
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return; // malformed URL -- let the browser handle it natively
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './offline.html'));
    return;
  }

  if (isCacheableStaticAsset(url)) {
    event.respondWith(networkFirst(request, null));
    return;
  }

  // Everything else (third-party hosts, /.netlify/functions/* calls,
  // fal.ai media URLs, non-GET already returned above) — no
  // respondWith() at all, so this request passes straight through to the
  // browser's own normal network handling, completely unintercepted.
});

// ==========================================================================
// Web push (tracker item for-product-build-stage-0-pwa-web-push-f-jbutt5,
// part 3/4) — this worker is also the delivery target for every push
// message netlify/functions/lib/push-sender.js sends via the Web Push
// protocol. See docs/PWA_PUSH_SETUP.md for the full server-side story;
// this is just the two browser-side event handlers every Web Push
// integration needs.
// ==========================================================================

/**
 * `data` (see push-sender.js's buildPushPayload) is always a small JSON
 * object: { title, body, url, type, distinctId }. `type` is 'video-ready'
 * or 'daily-claim-available' (see push-sender.js's PUSH_TYPES) — carried
 * through purely so a future notification-styling difference has
 * something to key off; both types render identically today. `distinctId`
 * is this account's raw username (the same PostHog distinct_id
 * js/store.js's identifyForAnalytics uses — see posthog-capture.js's own
 * header comment on why this must match) — carried on the notification's
 * own `data` so the 'push_clicked' fire below can attribute the click to
 * the right person without this worker needing any other source of
 * identity (a service worker has no access to this page's own
 * localStorage-backed DreamStore state).
 */
self.addEventListener('push', function (event) {
  var payload = { title: 'DreamTube', body: 'Your dream is ready.', url: './result.html', type: 'unknown', distinctId: null };
  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch (e) {
      // Not JSON (shouldn't happen — every real send from push-sender.js
      // sends JSON) — fall back to the generic defaults above rather than
      // showing no notification at all.
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'assets/logo-v4.png',
      badge: 'assets/logo-v4.png',
      data: { url: payload.url, type: payload.type, distinctId: payload.distinctId }
    })
  );
});

/**
 * PostHog's client JS SDK isn't available inside a service worker (no
 * `window`/`document`), and a clicked notification is just as likely to
 * have NO open DreamTube tab to postMessage into (the whole point of a
 * push notification is reaching someone who isn't currently on the site) —
 * so this posts directly to PostHog's public HTTP capture endpoint itself,
 * the same bare-fetch approach netlify/functions/lib/posthog-capture.js
 * uses server-side, rather than routing through a page. `importScripts`
 * (classic, non-module worker — this repo has no bundler, see CLAUDE.md)
 * pulls in the exact same POSTHOG_KEY/POSTHOG_HOST every other page reads
 * from, so this stays the one place those values live (see
 * js/analytics-config.js's own header comment on why neither is secret).
 * Fire-and-forget, same "analytics must never break the app" discipline
 * as every other capture call in this codebase — a failed fetch here just
 * means this one click isn't counted, never a broken notification click.
 */
self.addEventListener('notificationclick', function (event) {
  var data = (event.notification && event.notification.data) || {};
  event.notification.close();

  try {
    importScripts('js/analytics-config.js');
    if (typeof POSTHOG_KEY !== 'undefined' && POSTHOG_KEY !== 'REPLACE_WITH_REAL_POSTHOG_KEY' && data.distinctId) {
      fetch(POSTHOG_HOST + '/capture/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event: 'push_clicked',
          distinct_id: data.distinctId,
          properties: { type: data.type || 'unknown' }
        })
      }).catch(function () { /* analytics must never break the app */ });
    }
  } catch (e) { /* importScripts can throw if analytics-config.js is unreachable offline -- never block opening the app below */ }

  var targetUrl = data.url || './result.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          // Best-effort deep link -- if navigate() isn't available/fails
          // (e.g. an older engine), still focus the existing tab rather
          // than opening a redundant second one.
          if (typeof client.navigate === 'function') {
            client.navigate(targetUrl).catch(function () { /* still focus below */ });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
