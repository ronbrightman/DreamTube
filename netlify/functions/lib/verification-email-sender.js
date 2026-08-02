// netlify/functions/lib/verification-email-sender.js
//
// Sends the deferred-email-verification message (tracker item
// for-product-build-passwordless-signup-fo-at2fko) — the ONE email that
// carries BOTH verification paths this feature supports: a 6-digit code
// (typed back in later, at whatever deferred moment the app prompts for
// it — see js/email-verify-sheet.js) and a "click to verify instantly"
// link (implicit verification — see verify-email-link.js). Mirrors
// request-password-reset.js's own Resend-send shape (RESEND_API_BASE/
// FROM_ADDRESS constants, best-effort try/catch around the fetch, never
// throws) rather than inventing a new one.
//
// FIRE-AND-FORGET / NEVER BLOCKS SIGNUP: same "never let email delivery
// block a real product action" discipline as lib/first-dream-email-
// sender.js's own sendIfEligible — register-account-passwordless.js calls
// this WITHOUT awaiting it in the response path that matters (it awaits
// the promise so errors are logged, but a slow/failed Resend call never
// delays or fails the signup response itself — see that endpoint's own
// call site comment). This module itself never throws either way.
//
// IMPLICIT VERIFICATION LINK, SCOPE (documented deliberate limit — see
// this feature's own tracker item, "genuinely can't fit the whole spec...
// flag what's deferred"): the founder's spec says "every outbound email
// this account receives" should carry this link. This build wires it into
// ONLY this one email (the account's dedicated verification email) — not
// retrofitted onto lib/first-dream-email-sender.js's "your dream is ready"
// email, and deliberately NOT onto request-password-reset.js's reset email
// (that one already has its own single-purpose, must-not-be-confused-with-
// anything-else token flow; splicing a second, differently-scoped token
// into the same link would be a real footgun, not a simplification).
// Broadening this to every other transactional email this app sends is a
// real, separate follow-up, not done here.
//
// Error codes: none — this module never returns an HTTP-shaped error, only
// { ok:true, sent:true|false, skipped:<reason> }, same contract shape as
// lib/first-dream-email-sender.js's sendIfEligible for the same reason
// (every caller here treats this as best-effort).

var emailVerificationStore = require('./email-verification-store');

var RESEND_API_BASE = 'https://api.resend.com/emails';
// Deliberately duplicated from every other Resend-sending file in this
// codebase's own identical constant — see lib/first-dream-email-sender.js's
// header comment on why (small, self-contained per-file constants are this
// codebase's own established convention over one shared constants module).
var FROM_ADDRESS = 'DreamTube <dreams@dreamtube.life>';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `x-forwarded-host || host`, this codebase's existing convention (see facebook-oauth-callback.js's selfOrigin, request-password-reset.js). */
function selfOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host || '';
  return 'https://' + host;
}

function buildVerifyLinkUrl(event, linkToken) {
  return selfOrigin(event) + '/.netlify/functions/verify-email-link?token=' + encodeURIComponent(linkToken);
}

function buildHtml(code, verifyUrl) {
  return (
    '<div style="max-width:480px;margin:0 auto;font-family:sans-serif;">' +
    '<p style="font-size:16px;">Your DreamTube verification code:</p>' +
    '<p style="font-size:32px; font-weight:700; letter-spacing:4px; margin:8px 0 20px;">' + esc(code) + '</p>' +
    '<p><a href="' + verifyUrl + '" style="display:inline-block;padding:12px 22px;background:#000;color:#fff;border-radius:24px;text-decoration:none;font-weight:600;">Or click here to verify instantly</a></p>' +
    '<p style="color:#666;font-size:13px;margin-top:16px;">You\'re already signed in — this just confirms this is really your email address. No need to do anything right now if you\'d rather wait.</p>' +
    '</div>'
  );
}

/**
 * Mints a fresh code + link token (via lib/email-verification-store.js,
 * OVERWRITING any previous still-pending verification for this account —
 * see that module's own header comment) and sends it. `opts`:
 *   username (required), email (required)
 *
 * Returns { ok:true, sent:true } on an accepted Resend send, or
 * { ok:true, sent:false, skipped:<reason> } for every other outcome
 * (missing identity, no RESEND_API_KEY configured, or Resend itself
 * rejecting/failing the request) — never throws, matching every other
 * best-effort sender in this codebase.
 */
async function sendVerificationEmail(event, opts) {
  opts = opts || {};
  var username = opts.username;
  var email = opts.email;
  if (!username || !email) {
    return { ok: true, sent: false, skipped: 'missing_identity' };
  }

  var resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('verification-email-sender: RESEND_API_KEY not configured -- skipping send for ' + username);
    return { ok: true, sent: false, skipped: 'no_resend_key' };
  }

  var minted = await emailVerificationStore.createVerification(event, username, email);
  if (!minted.ok) {
    console.error('verification-email-sender: failed to mint a verification record', minted.error);
    return { ok: true, sent: false, skipped: 'mint_failed' };
  }

  var verifyUrl = buildVerifyLinkUrl(event, minted.linkToken);
  var html = buildHtml(minted.code, verifyUrl);

  try {
    var res = await fetch(RESEND_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + resendKey },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [email],
        subject: 'Your DreamTube verification code: ' + minted.code,
        html: html
      })
    });
    if (!res.ok) {
      console.error('verification-email-sender: Resend rejected the send', res.status);
      return { ok: true, sent: false, skipped: 'resend_rejected' };
    }
  } catch (sendErr) {
    console.error('verification-email-sender: Resend send failed (non-fatal)', sendErr);
    return { ok: true, sent: false, skipped: 'resend_network_failure' };
  }

  return { ok: true, sent: true };
}

module.exports = { sendVerificationEmail, buildHtml, buildVerifyLinkUrl };
