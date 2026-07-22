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

var _turnstileScriptPromise = null;

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
 * Renders the widget into a hidden, detached container — safe regardless
 * of whether the configured site key is Managed or Invisible mode (see
 * docs/TURNSTILE_SETUP.md): Invisible mode never shows UI at all, and
 * Managed mode only shows an interactive challenge on traffic Cloudflare's
 * own risk scoring flags, which this container's display:none would hide
 * anyway — deliberately chosen over a permanently-visible checkbox widget
 * so legitimate users see zero added friction in the common case.
 */
function getTurnstileToken() {
  if (typeof TURNSTILE_SITE_KEY === 'undefined' || TURNSTILE_SITE_KEY === 'REPLACE_WITH_REAL_TURNSTILE_SITE_KEY') {
    return Promise.resolve(null);
  }

  return _loadTurnstileScript().then(function () {
    return new Promise(function (resolve) {
      var settled = false;
      function done(token) {
        if (settled) return;
        settled = true;
        resolve(token || null);
      }

      var timer = setTimeout(function () { done(null); }, TURNSTILE_TOKEN_TIMEOUT_MS);

      var container = document.createElement('div');
      container.style.display = 'none';
      document.body.appendChild(container);

      try {
        window.turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: function (token) { clearTimeout(timer); done(token); },
          'error-callback': function () { clearTimeout(timer); done(null); },
          'expired-callback': function () { clearTimeout(timer); done(null); }
        });
      } catch (e) {
        clearTimeout(timer);
        done(null);
      }
    });
  }).catch(function () {
    return null; // script failed to load — never block generation on this
  });
}
