// netlify/functions/verify-email-link.js
//
// GET ?token=...&redirect=<path> -> the IMPLICIT verification path (tracker
// item for-product-build-passwordless-signup-fo-at2fko, founder's own
// words: "Any click on a link in our emails counts as implicit
// verification — mark verified, never ask for the code"). A BROWSER
// REDIRECT TARGET, not a JSON API — same shape as facebook-oauth-
// callback.js/create-session-transfer.js: the visitor's browser lands here
// directly from the link in the email, this verifies + marks the account,
// and always 302s onward into the app, on every outcome, success or
// failure alike (a human clicking an email link should never see a raw
// JSON error body).
//
// NO SESSION / NO AUTH REQUIRED, deliberately: the whole point of this
// mechanism is that clicking the link is itself the proof of inbox
// ownership — same "prove you own this inbox" trust model request-
// password-reset.js/verify-password-reset.js already use for a different
// purpose (resetting a password) via the exact same "mint a token, put it
// in a URL, verify it server-side on load" pattern, reused here rather
// than invented fresh. The clicking device doesn't need to be, and often
// won't be, the same device/browser that's signed into the account (an
// email link is routinely opened on a phone's mail app while the account
// itself is signed in on a desktop browser) — that's fine and expected;
// nothing about verifying an email's ownership requires the CURRENT
// device to also be logged in.
//
// `redirect` (optional): a same-app-relative path to land on after
// verifying — defaults to /profile.html (an already-authenticated app
// page whose own login gate handles "not signed in on this exact device"
// the same way it does for any other direct link into the app — see
// lib/first-dream-email-sender.js's own header comment on why that page is
// the right generic landing spot). Validated with the exact same
// isSafeRedirectPath open-redirect guard create-checkout-session-dodo.js
// already established (same reasoning: a relative-path-only check that
// never has to trust this function's own derivation of its origin from
// request headers) — duplicated here rather than factored into a shared
// module, matching this codebase's existing per-file small-helper
// convention (see create-checkout-session-dodo.js's own header comment for
// why redirect-safety helpers stay local rather than centralized).
//
// Error slugs (surfaced as ?verify_error=<slug> on the redirect; a
// successful verify instead carries ?verified=1):
//   E1 method_not_allowed     — verb other than GET (a real 405, no
//                                redirect — a browser link click is always
//                                a GET; only a misconfigured caller hits
//                                this)
//   E2 missing_token          — no `token` on the query string at all
//   E3 invalid_or_expired     — token unknown, already used, or expired

var emailVerificationStore = require('./lib/email-verification-store');
var accountStore = require('./lib/account-store');

var REDIRECT_PATH_RE = /^\/(?!\/)/;
var REDIRECT_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
var REDIRECT_CONTROL_CHAR_RE = /[\x00-\x1f\\]/;
function isSafeRedirectPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!REDIRECT_PATH_RE.test(candidate)) return false;
  if (REDIRECT_SCHEME_RE.test(candidate)) return false;
  if (REDIRECT_CONTROL_CHAR_RE.test(candidate)) return false;
  return true;
}

function selfOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host || '';
  return 'https://' + host;
}

function redirect(event, path, params) {
  var url = new URL(selfOrigin(event) + path);
  Object.keys(params || {}).forEach(function (key) {
    if (params[key] !== null && params[key] !== undefined) url.searchParams.set(key, params[key]);
  });
  return { statusCode: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' }, body: '' };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var query = event.queryStringParameters || {};
  var destination = isSafeRedirectPath(query.redirect) ? query.redirect : '/profile.html';

  var token = (query.token || '').trim();
  if (!token) {
    return redirect(event, destination, { verify_error: 'E2: missing_token' });
  }

  var resolved = await emailVerificationStore.verifyLinkToken(event, token);
  if (!resolved.ok) {
    return redirect(event, destination, { verify_error: 'E3: invalid_or_expired' });
  }

  await accountStore.markEmailVerified(event, resolved.username);
  return redirect(event, destination, { verified: '1' });
};
