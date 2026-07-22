// js/turnstile-config.js
//
// Cloudflare Turnstile client-side integration — the baseline bot-abuse
// layer in front of DreamTube's real generation call. Attached to
// netlify/functions/generate-video.js (see that file's E113 doc block),
// via processing.html's runGeneration() — the one real choke point every
// generation path (a brand-new generation from style.html, an edit/
// regenerate from result.html, a retry from processing.html itself) funnels
// through. Deliberately NOT attached to signup: js/store.js's signup() is
// 100% client-side (writes to localStorage only, no server round-trip at
// all today), so there's nowhere server-side to verify a token against
// there without inventing new server surface — see docs/TURNSTILE_SETUP.md
// for the full reasoning and entitlements.js's per-IP signup-bonus-cap doc
// comment for the precedent this follows.
//
// TURNSTILE_SITE_KEY below is a placeholder on purpose — no real
// Cloudflare Turnstile site exists yet (creating one is a human sign-up
// step, not something this codebase can do for itself; see
// docs/TURNSTILE_SETUP.md for exactly what's still needed). Every call to
// getTurnstileToken() checks for the literal placeholder string and, if
// it's still there, resolves immediately with null — no script load, no
// widget render, no network call, and (critically) no delay added to the
// generation flow. This mirrors js/analytics-config.js's POSTHOG_KEY/
// META_PIXEL_ID pattern exactly: the only edit needed anywhere in the
// codebase to turn this feature on is dropping the real site key in below.
//
// TO GO LIVE: replace TURNSTILE_SITE_KEY with the real value from the
// founder's Cloudflare Turnstile site settings (see
// docs/TURNSTILE_SETUP.md), created there as a Managed or Invisible widget
// — that choice is made once, in Cloudflare's dashboard, when the site key
// itself is created; it is NOT a parameter this file's render() call
// controls. Nothing else in this file needs to change once a real key is
// in place.

var TURNSTILE_SITE_KEY = 'REPLACE_WITH_REAL_TURNSTILE_SITE_KEY';

var TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// How long to wait for a token before giving up and proceeding without one.
// getTurnstileToken() never rejects (see its own doc comment for why
// "resolve null and let generation proceed" is the correct failure mode
// here, not hanging indefinitely) — this timeout is what makes that
// guarantee real even if Cloudflare's script never calls back at all.
// Generous on purpose: Managed/Invisible mode is usually non-interactive
// and resolves in well under a second, but a slow network or a Cloudflare
// hiccup shouldn't be able to stall the whole generation flow.
var TURNSTILE_TOKEN_TIMEOUT_MS = 8000;

// If Cloudflare's risk engine decides a *Managed*-mode widget needs an
// interactive challenge (see 'before-interactive-callback' below), the
// short timeout above is replaced with this much longer one — a real
// person solving a visible checkbox/puzzle needs more than 8 seconds, and
// the timeout's job at that point is purely "don't hang forever if they
// abandon the tab," not "keep the common non-interactive case snappy."
var TURNSTILE_INTERACTIVE_TIMEOUT_MS = 120000;

var _turnstileScriptPromise = null;

// Tracks the single most recently rendered widget/container so a fresh
// getTurnstileToken() call (e.g. processing.html's "Try Again" retry,
// which can fire repeatedly without a page reload) can tear down the
// previous one instead of leaking widget instances/DOM nodes for the
// life of the page.
var _activeTurnstileWidgetId = null;
var _activeTurnstileContainer = null;

// Tracks the in-flight getTurnstileToken() promise, if any, so a second
// call made *before* the first has settled (e.g. a user is mid-solve on a
// visible interactive challenge) returns that same promise instead of
// tearing the live widget down out from under them and starting a new
// one. This is distinct from the retry case _activeTurnstileWidgetId/
// _activeTurnstileContainer above handle: a retry only ever happens after
// the previous call has already resolved (processing.html's only caller
// of getTurnstileToken() can't fire again until the prior generation
// attempt has finished), at which point this is back to null and the
// normal cleanup-then-render-fresh path runs as before.
var _pendingTurnstileTokenPromise = null;

/** Removes the previous widget (if any) via the Turnstile API, plus its container DOM node. Safe to call even if nothing is active. */
function _cleanupTurnstileWidget() {
  if (_activeTurnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.remove(_activeTurnstileWidgetId); } catch (e) { /* already gone */ }
  }
  if (_activeTurnstileContainer && _activeTurnstileContainer.parentNode) {
    _activeTurnstileContainer.parentNode.removeChild(_activeTurnstileContainer);
  }
  _activeTurnstileWidgetId = null;
  _activeTurnstileContainer = null;
}

/** Loads Cloudflare's Turnstile script exactly once per page load, however many times getTurnstileToken() is called. */
function _loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (_turnstileScriptPromise) return _turnstileScriptPromise;
  _turnstileScriptPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = TURNSTILE_SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('turnstile_script_load_failed')); };
    document.head.appendChild(s);
  });
  return _turnstileScriptPromise;
}

/**
 * Resolves to a Turnstile token string, or null if Turnstile isn't
 * configured yet (placeholder site key) or if anything went wrong
 * obtaining one (script failed to load, the widget errored/expired, or
 * the TURNSTILE_TOKEN_TIMEOUT_MS budget ran out). NEVER rejects — a
 * bot-abuse layer must never be the reason a real user's generation fails
 * to even be attempted. When this resolves null and a real
 * TURNSTILE_SECRET_KEY happens to be configured server-side, the actual
 * rejection (E113) happens there, not here — this function's only job is
 * best-effort token acquisition, never enforcement.
 *
 * Renders the widget into a container that starts hidden (display:none) —
 * fine for Invisible mode, which never shows UI at all, and fine for the
 * common Managed-mode case too, where Cloudflare's risk scoring is happy
 * with a non-interactive pass. But Managed mode can also decide a given
 * request needs an interactive checkbox/puzzle challenge, and a user in
 * that bucket can't complete a challenge they can't see — so this promotes
 * the container to a visible, centered overlay for exactly that case, via
 * Turnstile's 'before-interactive-callback'/'after-interactive-callback'
 * hooks (fired only when Cloudflare actually needs interaction), and hides
 * it again once the challenge is resolved. Legitimate non-interactive
 * traffic (the large majority) never sees this — it stays exactly as
 * invisible and frictionless as before.
 *
 * Calling this again while a previous call hasn't settled yet returns
 * that SAME promise rather than tearing down the active widget — see
 * _pendingTurnstileTokenPromise's own doc comment for why.
 */
function getTurnstileToken() {
  if (typeof TURNSTILE_SITE_KEY === 'undefined' || TURNSTILE_SITE_KEY === 'REPLACE_WITH_REAL_TURNSTILE_SITE_KEY') {
    return Promise.resolve(null);
  }

  if (_pendingTurnstileTokenPromise) {
    return _pendingTurnstileTokenPromise;
  }

  // Tear down any widget left over from a previous, already-settled call
  // (e.g. a retry) before rendering a new one — see
  // _cleanupTurnstileWidget()'s doc comment.
  _cleanupTurnstileWidget();

  var resultPromise = _loadTurnstileScript().then(function () {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;

      var container = document.createElement('div');
      container.style.display = 'none';
      container.setAttribute('aria-live', 'polite');
      document.body.appendChild(container);
      _activeTurnstileContainer = container;

      function done(token) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        _cleanupTurnstileWidget();
        _pendingTurnstileTokenPromise = null;
        resolve(token || null);
      }

      function showInteractiveChallenge() {
        // Restart the timeout budget on the much longer interactive
        // allowance — see TURNSTILE_INTERACTIVE_TIMEOUT_MS's doc comment —
        // and promote the container from an invisible detached node to a
        // centered overlay so the user can actually see and solve it.
        clearTimeout(timer);
        timer = setTimeout(function () { done(null); }, TURNSTILE_INTERACTIVE_TIMEOUT_MS);
        container.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;' +
          'justify-content:center;background:rgba(0,0,0,0.55);z-index:9999;';
      }

      function hideInteractiveChallenge() {
        container.style.cssText = 'display:none;';
      }

      timer = setTimeout(function () { done(null); }, TURNSTILE_TOKEN_TIMEOUT_MS);

      try {
        _activeTurnstileWidgetId = window.turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: function (token) { done(token); },
          'error-callback': function () { done(null); },
          'expired-callback': function () { done(null); },
          'before-interactive-callback': function () { showInteractiveChallenge(); },
          'after-interactive-callback': function () { hideInteractiveChallenge(); }
        });
      } catch (e) {
        done(null);
      }
    });
  }).catch(function () {
    _cleanupTurnstileWidget();
    _pendingTurnstileTokenPromise = null;
    return null; // script failed to load — never block generation on this
  });

  _pendingTurnstileTokenPromise = resultPromise;
  return resultPromise;
}
