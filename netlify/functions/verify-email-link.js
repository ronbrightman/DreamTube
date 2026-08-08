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
// SESSION ON SUCCESS (added alongside the register-account-passwordless.js
// security fix — tracker item for-product-build-passwordless-signup-fo-
// at2fko): a successful verify now ALSO mints a lib/session-transfer-
// token.js token and appends it to the redirect as `?bt=`, exactly the
// mechanism facebook-oauth-callback.js already uses once IT has confirmed
// a real identity via Facebook's own servers (see that file's own
// resolveIdentity + redirect call). Trusted here for the exact same
// reason: verifyLinkToken above is itself the proof of ownership (the
// browser could only have reached this handler at all by dereferencing a
// token that was mailed to the real inbox) — this is not a new, weaker
// trust boundary, it's the SAME one that already gates markEmailVerified
// two lines below, just also used to grant a session now that this
// feature actually needs one gated behind it (see register-account-
// passwordless.js's own header comment for the account-takeover this
// closes: a bare email POST no longer mints a session on its own, so the
// mailed link needs to be able to grant one itself, or the "click a link
// to log in" half of this feature would have no way to ever complete).
//
// `redirect` (optional): a same-app-relative path to land on after
// verifying — defaults to /home.html specifically because that page (like
// start.html/create.html/result.html) already calls
// DreamStore.consumeSessionTransferTokenFromUrlSync() on load, which is
// what actually turns the `?bt=` token above into a real local session —
// profile.html does NOT call that function, so a caller-supplied
// `redirect` to a page that never consumes `bt` will (silently, same
// "never a visible error" posture as an expired token) just fail to
// establish a session on that device, exactly like an ordinary expired/
// unconsumed session-transfer token anywhere else in this codebase.
// Validated with the exact same isSafeRedirectPath open-redirect guard
// create-checkout-session-dodo.js already established (same reasoning: a
// relative-path-only check that never has to trust this function's own
// derivation of its origin from request headers) — duplicated here rather
// than factored into a shared module, matching this codebase's existing
// per-file small-helper convention (see create-checkout-session-dodo.js's
// own header comment for why redirect-safety helpers stay local rather
// than centralized).
//
// Error slugs (surfaced as ?verify_error=<slug> on the redirect; a
// successful verify instead carries ?verified=1&bt=<session-transfer-token>):
//   E1 method_not_allowed     — verb other than GET (a real 405, no
//                                redirect — a browser link click is always
//                                a GET; only a misconfigured caller hits
//                                this)
//   E2 missing_token          — no `token` on the query string at all
//   E3 invalid_or_expired     — token unknown, already used, or expired

var emailVerificationStore = require('./lib/email-verification-store');
var accountStore = require('./lib/account-store');
var sessionTransferToken = require('./lib/session-transfer-token');
var entitlements = require('./lib/entitlements');

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
  var destination = isSafeRedirectPath(query.redirect) ? query.redirect : '/home.html';

  var token = (query.token || '').trim();
  if (!token) {
    return redirect(event, destination, { verify_error: 'E2: missing_token' });
  }

  var resolved = await emailVerificationStore.verifyLinkToken(event, token);
  if (!resolved.ok) {
    return redirect(event, destination, { verify_error: 'E3: invalid_or_expired' });
  }

  var marked = await accountStore.markEmailVerified(event, resolved.username);

  // +20 email-verification bonus — the implicit-verification half of the
  // same grant verify-email-code.js makes explicitly (one shared
  // achievement id, entitlements.EMAIL_VERIFIED_ACHIEVEMENT_ID, so the two
  // paths can only ever credit ONCE between them; see that endpoint's
  // fuller comment for the flip-gating + replay reasoning). Fully silent
  // here: this handler is a browser redirect target that must 302 onward
  // on every outcome (see header comment), so there is no JSON response to
  // carry the grant result — the home page's bonus row and balance simply
  // reflect it on landing. Best-effort for the same reason: a grant
  // bookkeeping failure must never break a human's email-link click.
  // Rate limiting per applyAchievementGrant's caller contract: the mailed
  // single-use token IS the gate — the grant is unreachable without
  // dereferencing a token only the real inbox owner ever held.
  if (marked.ok && marked.changed && marked.record && marked.record.email) {
    try {
      await entitlements.applyAchievementGrant(
        event,
        marked.record.email,
        entitlements.EMAIL_VERIFIED_ACHIEVEMENT_ID,
        { type: 'tokens', amount: entitlements.EMAIL_VERIFIED_BONUS_AMOUNT }
      );
    } catch (e) {
      // Exhaustion only — the verification + redirect must proceed regardless.
    }
  }

  // See header comment's "SESSION ON SUCCESS" section — this is what lets
  // the mailed link actually complete a login for an account that had NO
  // prior session anywhere (register-account-passwordless.js's RESOLVE
  // branch). account lookup is only to get the email session-transfer-
  // token.js's createToken wants alongside the username; a missing record
  // here would be a genuine data inconsistency (verifyLinkToken just
  // resolved this exact username), so `null` is a safe, harmless fallback
  // rather than something worth failing the whole request over.
  var account = await accountStore.getByUsername(event, resolved.username);
  var transferToken = await sessionTransferToken.createToken(event, resolved.username, (account && account.email) || null);

  return redirect(event, destination, { verified: '1', bt: transferToken });
};
