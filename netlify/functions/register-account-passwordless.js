// netlify/functions/register-account-passwordless.js
//
// POST { email } -> the passwordless-signup entry point (tracker item
// for-product-build-passwordless-signup-fo-at2fko, founder-decided:
// "at the wall the user types ONLY an email and is instantly in — no
// password field ever, no inbox check at the wall"). A genuinely NEW
// signup path, NOT a variant of register-account.js — no password is ever
// accepted, required, or stored (the account record's `password` field is
// `null`, an already-accepted shape in this codebase — a session-transfer
// account materializes the same — see lib/account-store.js's header comment).
//
// SECURITY FIX (round-2 review finding, real, fixed 2026-08-02 — read
// before changing anything below): an earlier version of this file
// resolved an already-registered email to its existing account AND minted
// a fully usable authToken for it, with ZERO proof the caller controls
// that inbox. That is a complete, one-request account takeover — anyone
// who knows a victim's public email address (every DreamTube handle's
// email is not itself public, but this endpoint doesn't check anything
// AT ALL, so it doesn't matter) gets a real session for that account.
//
// SECURITY BOUNDARY: this endpoint has NO step that proves the caller
// actually owns the email they submit — it starts from the raw client-
// supplied email string directly, which is not proof of anything. That is
// why an EXISTING account is never handed a session from here: an existing
// account is protected data, so branch 1 below routes it through the
// email-code verification (real ownership proof) before any session is
// issued. Only a brand-new account (branch 2) — which has nothing to
// protect yet — gets an immediate session.
//
// The founder's own "instantly in, no inbox check at the wall" spec
// describes a genuinely NEW signup (branch 2 below) — there is nothing to
// protect yet on a brand-new account, so no proof is needed before it's
// usable. It does NOT mean typing someone ELSE's already-registered email
// should grant instant access to THEIR account.
//
// CORRECTED IDENTITY RESOLUTION:
//   1. getByEmail hit  -> RESOLVE, but do NOT mint a session. A fresh
//      code + implicit-verification link are sent to that account's real
//      email (same lib/verification-email-sender.js call the create
//      branch uses), and the response carries NO authToken/username at
//      all — { ok:true, created:false, pendingVerification:true }. The
//      caller must actually prove they control that inbox via one of:
//        - login-with-email-code.js: POST {email, code} -> mints a real
//          session ONLY once the mailed code checks out.
//        - verify-email-link.js: clicking the mailed link both verifies
//          AND (as of this fix) mints a session-transfer token for
//          whatever device clicks it — see that file's own header
//          comment.
//      This is the exact same "prove ownership via a mailed code/link,
//      THEN get a session" mechanism this feature already built for
//      deferred verification — reused here as the actual access-control
//      gate for an existing account, not invented fresh.
//   2. getByEmail miss -> CREATE a brand-new account: username derived via
//      lib/derive-username.js (the shared server-side derivation for "we
//      have an email but need a username"), password:null,
//      emailVerified:false. THIS branch
//      alone mints a real authToken immediately and sends the
//      verification email fire-and-forget (see the FIRE-AND-FORGET note
//      below) — "instantly in" applies here, and only here, because
//      there is nothing pre-existing this request could be hijacking.
//
// FIRE-AND-FORGET EMAIL SEND (branch 2 only): the verification email is
// sent AFTER the account is created but the response is NOT held up
// waiting for Resend — same "never let email delivery block a real
// product action" discipline as lib/first-dream-email-sender.js. The send
// is still AWAITED (not a bare unresolved promise) so a real error is
// logged, but only after the account genuinely exists and mints its
// token; nothing about a slow or failed Resend call can prevent or delay
// the signup itself. Branch 1's send is likewise awaited-for-logging-only,
// but happens BEFORE anything privileged is returned (there is nothing
// privileged returned on branch 1 either way).
//
// Response shapes:
//   200 { ok:true, created:true, username, email, authToken, emailVerified:false }
//     — branch 2, a genuinely new account. Only shape that ever carries
//       authToken/username.
//   200 { ok:true, created:false, pendingVerification:true }
//     — branch 1, an existing account was found. No authToken, no
//       username — the client must now show a "check your email" step
//       (see start.html's renderScreen13Passwordless) and call
//       login-with-email-code.js or wait for a link click.
//   200 { ok:false, error: 'E6: no_available_username' } — see
//       lib/derive-username.js's own fail-closed contract; effectively
//       unreachable in practice (8 collision retries on a truly random
//       email-derived base), kept as a real, handled branch rather than an
//       assumed-unreachable one.
//   429 { ok:false, error: 'E5: rate_limited: ...' } — see register-
//       account.js's own identical E9 for why this carries ok:false (a
//       client branching on `.ok`, not HTTP status, must never mistake a
//       429 for a malformed response and silently retry/fall back wrong).
//
// Error codes (local to this function, same small-number-scheme reasoning
// as register-account.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 email_required
//   E4 invalid_email
//   E5 rate_limited          — MAX_REGISTRATIONS_PER_IP_PER_DAY exceeded
//                               (reuses the SAME env var and daily cap
//                               register-account.js already uses — this is
//                               still "account creation in general" under
//                               contention, the same reasoning that file's
//                               own header comment gives for why it's a
//                               single per-IP bucket, not per-identifier)
//   E6 no_available_username — see above
//   E7 server_error           — account creation itself failed unexpectedly
//                                (a getByEmail miss followed by a
//                                createAccount 'email_taken'/'username_taken'
//                                collision — the same narrow non-atomic-
//                                write race account-store.js's own header
//                                comment documents as accepted elsewhere;
//                                a retried signup for the same email just
//                                resolves as a pending-verification response
//                                on the next attempt)

var accountStore = require('./lib/account-store');
var deriveUsername = require('./lib/derive-username');
var rateLimit = require('./lib/rate-limit');
var accountAuthToken = require('./lib/account-auth-token');
var verificationEmailSender = require('./lib/verification-email-sender');

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The "brand-new account" branch — derive an available username and create
 * the account with password:null and emailVerified:false (see
 * account-store.js's GATE LIST header comment for why a passwordless
 * signup starts unverified).
 */
async function createPasswordlessAccount(event, email) {
  var derived = await deriveUsername.deriveAvailableUsername(email, async function (candidate) {
    return !!(await accountStore.getByUsername(event, candidate));
  });
  if (!derived.ok) return { ok: false, error: derived.error };

  var created = await accountStore.createAccount(event, {
    username: derived.username,
    password: null,
    email: email,
    emailVerified: false
  });
  if (!created.ok) return { ok: false, error: created.error };
  return { ok: true, record: created.record, created: true };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var email = (payload.email || '').trim();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: email_required' }) };
  }
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_email' }) };
  }

  // Same per-IP daily cap register-account.js already enforces, same env
  // var — see header comment.
  var maxPerDay = parseInt(process.env.MAX_REGISTRATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'register-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited: too many signups from this network today, try again tomorrow' }) };
  }

  try {
    var existing = await accountStore.getByEmail(event, email);

    // Branch 1 — RESOLVE, but never mint a session here. See header
    // comment's SECURITY FIX section for the full "why". A fresh code +
    // link are sent (this account may never have completed verification,
    // or its original code may be long expired/lost); the caller must
    // prove ownership via login-with-email-code.js or the mailed link
    // before getting anything usable.
    if (existing) {
      await verificationEmailSender.sendVerificationEmail(event, {
        username: existing.username,
        email: existing.email
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, created: false, pendingVerification: true }) };
    }

    // Branch 2 — CREATE. Nothing pre-existing to protect, so this is the
    // one case that's genuinely "instantly in".
    var created = await createPasswordlessAccount(event, email);
    if (!created.ok) {
      var code = created.error === 'no_available_username' ? 'E6: no_available_username' : 'E7: server_error';
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
    }

    var authToken = await accountAuthToken.mintToken(event, created.record.username);

    // Fire-and-forget send, AWAITED for logging only — see header comment.
    await verificationEmailSender.sendVerificationEmail(event, {
      username: created.record.username,
      email: created.record.email
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        created: true,
        username: created.record.username,
        email: created.record.email,
        authToken: authToken,
        emailVerified: false
      })
    };
  } catch (e) {
    console.error('register-account-passwordless: unexpected error', e);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E7: server_error' }) };
  }
};
