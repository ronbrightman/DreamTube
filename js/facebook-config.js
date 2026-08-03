// js/facebook-config.js
//
// Facebook Login client-side configuration + OAuth-redirect helpers — the
// client half of the "Continue with Facebook" signup path spec'd in
// docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md (tracker items
// for-product-priority-founder-2026-07-30--ruzc5u and
// for-product-signup-screen-the-single-big-bkwhbe). The server half is
// netlify/functions/facebook-oauth-callback.js.
//
// FACEBOOK_APP_ID below is the real "DreamTube Login" Meta app's public
// App ID (founder pasted it 2026-08-03; business verification done, app
// still Unpublished/dev-mode, so only app-role holders can complete the
// login until it passes App Review and is published — see the tracker's
// facebook-login items for the go-public checklist). The App ID is
// public by design — it appears in every OAuth dialog URL — the SECRET
// stays server-side only, in Netlify env, never in this repo.
// This file mirrors js/turnstile-config.js's TURNSTILE_SITE_KEY
// pattern EXACTLY: a literal placeholder string, checked at every call
// site, that makes the whole feature a no-op until a human drops in a
// real value. Concretely, while the placeholder is still here:
//   - isFacebookLoginConfigured() returns false,
//   - every button-render site (start.html's screen 13, both A/B
//     variants) writes NO button markup into the DOM at all — the button
//     is genuinely ABSENT, not present-but-hidden via CSS, per the spec's
//     §2.4 "Flag OFF" row,
//   - no facebook.com script is ever loaded (this feature deliberately
//     uses the manual/server-side OAuth REDIRECT flow, not the Facebook
//     JS SDK — see the spec's §1: popups are unreliable/blocked in the
//     exact FB/IG in-app webview this whole feature exists for, and the
//     SDK would also mean a third-party script on every pageview, which
//     this codebase's Turnstile/PostHog/Pixel pattern deliberately avoids
//     until a feature is genuinely real).
//
// TO GO LIVE: replace FACEBOOK_APP_ID below with the real App ID from the
// Meta app, AND set FACEBOOK_APP_ID/FACEBOOK_APP_SECRET as environment
// variables on the Netlify site (the secret is server-only and must never
// appear in this file). The callback function fails closed if the server
// env vars are missing, so a half-configured state can never half-work.
// Nothing else in this file or in start.html needs to change.

var FACEBOOK_APP_ID = '1575457744326846';

// Pinned Graph API version, shared by the client (dialog URL below) and
// the server (facebook-oauth-callback.js keeps its own copy — it can't
// require() a browser script). Bump both together.
var FACEBOOK_GRAPH_VERSION = 'v21.0';

// The one permission this flow asks for. `email` is what the whole
// account-linking design in the spec's §3 depends on ("same email = same
// account, never a duplicate"); the user can still decline it, which is
// exactly the "needs email" edge case the callback handles (§2.4).
var FACEBOOK_SCOPE = 'email';

// Short-lived, first-party CSRF cookie carrying the `state` nonce, read
// back server-side by facebook-oauth-callback.js. SameSite=Lax (NOT
// Strict) is required: the cookie has to survive a top-level GET
// navigation back from facebook.com, which Strict would drop, failing
// every legitimate login closed.
var FACEBOOK_STATE_COOKIE = 'dt_fb_state';
var FACEBOOK_STATE_COOKIE_MAX_AGE_S = 600; // 10 minutes — one round trip

// Soft cap on the resume params carried inside the `state` param (see
// buildFacebookState below). Facebook echoes `state` back verbatim, and
// an over-long OAuth dialog URL is a real failure mode in some in-app
// webviews — so the resume string is trimmed by DROPPING whole
// lower-priority params rather than by cutting the string mid-value
// (which would corrupt a caption).
var FACEBOOK_STATE_RESUME_MAX_CHARS = 1800;
// Priority order for that budget: everything the funnel genuinely cannot
// work without comes first. Params not listed here at all are dropped
// first of any — by definition they're outside the funnel's known handoff
// contract.
var FACEBOOK_RESUME_PARAM_PRIORITY = ['resume', 'caption', 'mode', 'style', 'recall', 'types', 'motivations', 'distinct_id', 'fbc', 'fbp', 'fbclid'];
// ...and these two are never dropped at all, budget or no budget. A
// slightly over-long URL is a risk; losing either of these is a
// certainty of breaking the visitor's funnel outright:
//   resume  — start.html's entry guard bounces any visit without it
//             straight back to the marketing funnel, so dropping it would
//             eject the visitor from the app entirely.
//   caption — the actual dream text. An unusually long one (the only way
//             the budget is ever reached in practice) would otherwise be
//             silently discarded, landing the visitor back in the funnel
//             with an empty dream and no idea why.
var FACEBOOK_RESUME_PARAMS_NEVER_DROPPED = ['resume', 'caption'];

/**
 * The single feature flag every render/click site must check first.
 * Returns false while the placeholder above is still in place (or if this
 * file somehow didn't load), which means: no button markup, no cookie, no
 * navigation to facebook.com — exactly as if this feature didn't exist.
 * Same shape as getTurnstileToken()'s own placeholder check.
 */
function isFacebookLoginConfigured() {
  return typeof FACEBOOK_APP_ID === 'string' &&
    !!FACEBOOK_APP_ID &&
    FACEBOOK_APP_ID !== 'REPLACE_WITH_REAL_FACEBOOK_APP_ID';
}

/**
 * The redirect_uri registered with the Meta app. MUST be byte-identical
 * between the dialog URL built here and the token exchange the callback
 * function performs server-side (Facebook rejects the exchange otherwise)
 * — the server rebuilds this same string from its own request Host header,
 * matching this codebase's existing `x-forwarded-host || host` convention
 * (lib/dream-share-token.js's buildUrl, request-password-reset.js).
 */
function facebookRedirectUri() {
  return location.origin + '/.netlify/functions/facebook-oauth-callback';
}

/** Cryptographically-random hex nonce for the CSRF state/cookie pair. Falls back to Math.random only where crypto.getRandomValues genuinely doesn't exist — a weaker nonce is still far better than skipping CSRF protection entirely, and the server-side check is unchanged either way. */
function facebookRandomNonce() {
  try {
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  } catch (e) {
    return String(Date.now()) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  }
}

/** URL-safe base64 (RFC 4648 §5) — `state` travels in a query string, so the standard alphabet's +/= would need escaping on every hop. Mirror of the server's own decode in facebook-oauth-callback.js. */
function facebookBase64UrlEncode(str) {
  var b64 = btoa(unescape(encodeURIComponent(str)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Trims a resume query string toward FACEBOOK_STATE_RESUME_MAX_CHARS by
 * dropping whole params in reverse-priority order (see
 * FACEBOOK_RESUME_PARAM_PRIORITY). Never truncates a value mid-string,
 * and never drops FACEBOOK_RESUME_PARAMS_NEVER_DROPPED — so the budget is
 * a soft target, and an unusually long caption comes back over-budget but
 * INTACT rather than silently missing.
 */
function trimResumeParams(search) {
  var params = new URLSearchParams(search || '');
  // `bt`/`fb_error`/`fb_needs_email` are OUR OWN return-trip markers, never
  // part of the outbound state — carrying one forward would re-trigger the
  // return handling on the next load with a stale/consumed value.
  params.delete('bt');
  params.delete('fb_error');
  params.delete('fb_needs_email');

  // Every param actually present that is allowed to be dropped, sorted
  // most-important first — so popping off the end always sacrifices the
  // least valuable thing still there. Anything absent from the priority
  // list sorts last of all, and goes first.
  var droppable = [];
  params.forEach(function (_value, key) {
    if (droppable.indexOf(key) !== -1) return;
    if (FACEBOOK_RESUME_PARAMS_NEVER_DROPPED.indexOf(key) !== -1) return;
    droppable.push(key);
  });
  droppable.sort(function (a, b) {
    var ai = FACEBOOK_RESUME_PARAM_PRIORITY.indexOf(a);
    var bi = FACEBOOK_RESUME_PARAM_PRIORITY.indexOf(b);
    if (ai === -1) ai = Infinity;
    if (bi === -1) bi = Infinity;
    return ai - bi;
  });

  while (droppable.length && params.toString().length > FACEBOOK_STATE_RESUME_MAX_CHARS) {
    params.delete(droppable.pop());
  }
  params.set('resume', '1');
  return params.toString();
}

/**
 * Builds the opaque `state` value: base64url(JSON{ n: nonce, r: resume
 * params }). `n` is what the server checks against the first-party cookie
 * (CSRF); `r` is what the server uses to reconstruct the return URL back
 * into this funnel, so a visitor lands back on exactly the dream they were
 * building rather than a bare start.html.
 */
function buildFacebookState(nonce, search) {
  return facebookBase64UrlEncode(JSON.stringify({ n: nonce, r: trimResumeParams(search) }));
}

/** Writes the short-lived first-party CSRF cookie. Same attribute shape as start.html's own setFirstPartyCookie for the Meta attribution cookies, just with a much shorter Max-Age. */
function setFacebookStateCookie(nonce) {
  try {
    document.cookie = FACEBOOK_STATE_COOKIE + '=' + encodeURIComponent(nonce) +
      '; path=/; max-age=' + FACEBOOK_STATE_COOKIE_MAX_AGE_S + '; SameSite=Lax; Secure';
    return true;
  } catch (e) {
    return false;
  }
}

/** The full Facebook OAuth dialog URL to full-page-navigate to. Never called while isFacebookLoginConfigured() is false. */
function buildFacebookOAuthUrl(state) {
  return 'https://www.facebook.com/' + FACEBOOK_GRAPH_VERSION + '/dialog/oauth' +
    '?client_id=' + encodeURIComponent(FACEBOOK_APP_ID) +
    '&redirect_uri=' + encodeURIComponent(facebookRedirectUri()) +
    '&state=' + encodeURIComponent(state) +
    '&scope=' + encodeURIComponent(FACEBOOK_SCOPE) +
    '&response_type=code';
}

/**
 * Meta-brand-compliant button markup. Meta's brand policy is a HARD
 * constraint (spec §1): the approved Facebook blue (#1877F2), the "f"
 * mark, and the approved copy "Continue with Facebook" used as-is — so
 * this button deliberately does NOT take start.html's pastel-gradient
 * .fn-btn-primary pill treatment the rest of that funnel uses. All styling
 * is inline here rather than in start.html's <style> block so the button
 * renders identically wherever it's dropped in, and so its VISUAL
 * treatment stays in one place, fully decoupled from its DOM position,
 * click handler, and every piece of backend logic (see start.html's own
 * comment on Direction X/Y).
 *
 * `id` defaults to 'fn-fb-continue' — the id start.html wires its click
 * handler to.
 *
 * ONE THING TO SWAP AT GO-LIVE, alongside the App ID: the "f" glyph below
 * is a hand-drawn approximation of Meta's mark, not their official asset
 * (this codebase can't fetch and vendor a third-party brand file on its
 * own, and js/icons.js is deliberately DreamTube's own line-style set —
 * this doesn't belong there). Meta's brand guidelines require their
 * supplied logo file, so whoever configures the real Meta app should
 * drop the official "f" SVG in here at the same time. Colour (#1877F2),
 * copy ("Continue with Facebook") and the no-restyling rule are already
 * compliant as-is.
 */
function facebookButtonHtml(id) {
  if (!isFacebookLoginConfigured()) return '';
  var mark = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" style="flex:0 0 auto;">' +
    '<path fill="#ffffff" d="M13.5 21v-8h2.7l.4-3.1h-3.1V7.9c0-.9.25-1.5 1.55-1.5H16.7V3.6c-.29-.04-1.27-.12-2.42-.12-2.4 0-4.03 1.46-4.03 4.15V9.9H7.5V13h2.75v8h3.25z"/>' +
    '</svg>';
  return '<button type="button" id="' + (id || 'fn-fb-continue') + '" ' +
    'style="width:100%; display:flex; align-items:center; justify-content:center; gap:10px; ' +
    'background:#1877F2; color:#fff; border:0; border-radius:14px; min-height:52px; padding:14px 18px; ' +
    'font-size:16px; font-weight:600; font-family:inherit; cursor:pointer; -webkit-appearance:none;">' +
    mark + '<span>Continue with Facebook</span></button>';
}
