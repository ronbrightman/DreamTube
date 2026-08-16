// netlify/functions/email-login.js
//
// One-tap login target for RETENTION/RECOVERY emails (founder decision
// 2026-08-15: "make the recovery/return emails auto-login"). A recipient
// taps the email's CTA, which points here carrying a single-use, 7-day
// lib/email-login-token.js token (`?elt=`); this endpoint consumes that
// token server-side, attaches any completed pending dream(s) for the email
// (cross-device, by-email — the tap is proof the inbox is owned, on whatever
// device opened it), mints a FRESH short-lived lib/session-transfer-token.js
// token, and 302-redirects to the destination page carrying `?bt=`, which
// js/store.js's consumeSessionTransferTokenFromUrlSync turns into a real
// local session. Net effect: tap the email -> land signed in, with the
// finished video already in the account.
//
// This is a deliberate, near-verbatim structural clone of verify-email-
// link.js — same redirect() helper, same isSafeRedirectPath allowlist gate,
// same createToken-then-redirect-with-?bt= handoff, same by-email pending-
// dream attach — differing only in which token type it consumes (a long-
// lived retention-email token, not a one-time email-VERIFICATION token) and
// in that it grants NO email-verification bonus (this is a login link for an
// already-known account, not a verification event).
//
// EVERY outcome 302-redirects onward (never a bare error page): an unknown,
// expired, already-consumed, or missing token simply redirects to the
// destination WITHOUT ?bt=, so the recipient lands on the normal signed-out
// page (they can log in manually) — exactly verify-email-link.js's graceful-
// fallthrough contract. `dest` is allowlisted to the two retention-email
// destinations; anything else falls back to /home.html.

var sessionTransferToken = require('./lib/session-transfer-token');
var emailLoginToken = require('./lib/email-login-token');
var accountStore = require('./lib/account-store');
var pendingDreamRecovery = require('./lib/pending-dream-recovery');

// Only the two pages retention/recovery emails actually point at. An
// allowlist (not a general isSafeRedirectPath) because this endpoint is
// reachable with an attacker-supplied `dest`, and every allowed page here is
// one that consumes ?bt= on load — an open same-origin redirect that also
// carries a real login token is worth keeping deliberately narrow.
var ALLOWED_DESTS = ['/profile.html', '/create.html', '/home.html'];
var DEFAULT_DEST = '/home.html';

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
  var destination = ALLOWED_DESTS.indexOf(query.dest) !== -1 ? query.dest : DEFAULT_DEST;

  // Email-click tracking (founder 2026-08-16): the recovery/winback CTAs route
  // their click through this endpoint, so forward the `ec` (email-type) marker
  // onto the final redirect — js/email-click-track.js on the landing page turns
  // it into an email_link_clicked event. Forwarded on EVERY outcome (a click is
  // a click even if the token is missing/expired). redirect() drops it when
  // absent, so ordinary logins are unaffected.
  var ec = query.ec;

  var token = (query.elt || '').trim();
  if (!token) {
    return redirect(event, destination, { login_error: 'E2: missing_token', ec: ec });
  }

  var resolved = await emailLoginToken.verifyAndConsumeToken(event, token);
  if (!resolved.ok) {
    // Unknown / expired / already-consumed — land signed-out, they can log in.
    return redirect(event, destination, { login_error: 'E3: invalid_or_expired', ec: ec });
  }

  // Look up the account for the email session-transfer-token.js's createToken
  // wants alongside the username. verifyAndConsumeToken just resolved this
  // exact username, so a missing record would be a genuine data
  // inconsistency; null email is a safe, harmless fallback rather than a
  // reason to fail a human's login click.
  var account = await accountStore.getByUsername(event, resolved.username);
  var email = (account && account.email) || resolved.email || null;

  // CROSS-DEVICE, BY-EMAIL attach — tapping this link is proof this inbox is
  // owned, on whatever device opened it (often a different one than where the
  // dream was built, with no device-local pendingId). Attach any completed
  // pending generation(s) for this email now, so the page this redirects into
  // (which consumes ?bt= then reconciles) surfaces the finished video.
  // Best-effort/awaited — the helper never throws and enforces ownership
  // internally. Mirrors verify-email-link.js's identical attach step.
  if (email) {
    try {
      await pendingDreamRecovery.attachCompletedPendingDreamsForEmail(event, email, resolved.username);
    } catch (e) {
      // Attach is best-effort — a login must complete regardless.
    }
  }

  // Mint a FRESH short-lived session-transfer token for the actual client
  // handoff — the long-lived email token is already consumed and never
  // reaches the browser. Same ?bt= mechanism as verify-email-link.js / the
  // FB OAuth callback.
  var transferToken = await sessionTransferToken.createToken(event, resolved.username, email);
  return redirect(event, destination, { bt: transferToken, ec: ec });
};
