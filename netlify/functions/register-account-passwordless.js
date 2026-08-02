// netlify/functions/register-account-passwordless.js
//
// POST { email } -> the passwordless-signup entry point (tracker item
// for-product-build-passwordless-signup-fo-at2fko, founder-decided:
// "at the wall the user types ONLY an email and is instantly in — no
// password field ever, no inbox check at the wall"). A genuinely NEW
// signup path, NOT a variant of register-account.js — no password is ever
// accepted, required, or stored (the account record's `password` field is
// `null`, the same already-accepted shape a Facebook-Login-only account
// uses — see lib/account-store.js's header comment).
//
// IDENTITY RESOLUTION — deliberately mirrors facebook-oauth-callback.js's
// resolveIdentity (email is the one source of truth for "does this person
// already have an account"), just without any fbUserId step:
//   1. getByEmail hit  -> RESOLVE (log into) that existing account. No new
//      account, no new verification email forced on top of whatever
//      verification state that account already has — see below.
//   2. getByEmail miss -> CREATE a brand-new account: username derived via
//      lib/derive-username.js (the same server-side derivation
//      facebook-oauth-callback.js already uses for "we have an email but
//      need a username"), password:null, emailVerified:false. Then fires
//      the verification-code email (lib/verification-email-sender.js),
//      fire-and-forget — see the FIRE-AND-FORGET note below.
// Either branch mints a fresh lib/account-auth-token.js token and lets the
// caller straight into the app — "instantly in" applies to BOTH a genuine
// first-time signup and a returning passwordless visitor typing their
// email again, since there's no password step to distinguish them at.
//
// FIRE-AND-FORGET EMAIL SEND: the verification email is sent AFTER the
// account is created but the response is NOT held up waiting for Resend —
// same "never let email delivery block a real product action" discipline
// as lib/first-dream-email-sender.js. The send is still AWAITED (not a
// bare unresolved promise) so a real error is logged, but only after the
// account genuinely exists and mints its token; nothing about a slow or
// failed Resend call can prevent or delay the signup itself.
//
// Response shapes:
//   200 { ok:true, username, email, authToken, created, emailVerified }
//     — created:true only on branch 2 above (a genuinely new account);
//       emailVerified mirrors the resolved/created account's own current
//       state (false for a fresh signup, whatever it already was for a
//       resolved existing one) so the client can decide locally whether to
//       ever bother prompting for a code later.
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
//                                resolves as a login on the next attempt)

var accountStore = require('./lib/account-store');
var deriveUsername = require('./lib/derive-username');
var rateLimit = require('./lib/rate-limit');
var accountAuthToken = require('./lib/account-auth-token');
var verificationEmailSender = require('./lib/verification-email-sender');

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The "brand-new account" branch — mirrors facebook-oauth-callback.js's
 * createFacebookAccount shape exactly (derive an available username,
 * create with password:null), just with emailVerified:false instead of
 * true (see account-store.js's GATE LIST header comment for why the two
 * differ) and no fbUserId at all.
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
    var resolved;
    if (existing) {
      resolved = { ok: true, record: existing, created: false };
    } else {
      resolved = await createPasswordlessAccount(event, email);
      if (!resolved.ok) {
        var code = resolved.error === 'no_available_username' ? 'E6: no_available_username' : 'E7: server_error';
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
      }
    }

    var authToken = await accountAuthToken.mintToken(event, resolved.record.username);

    // Fire-and-forget send, AWAITED for logging only — see header comment.
    // Only ever sent for a genuinely brand-new, still-unverified account:
    // a RESOLVED (existing) account never gets a surprise re-send just for
    // typing its email into the wall again — if it wants a fresh code it
    // uses the explicit resend-verification-code.js endpoint instead (see
    // that file's own header comment).
    if (resolved.created) {
      await verificationEmailSender.sendVerificationEmail(event, {
        username: resolved.record.username,
        email: resolved.record.email
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        username: resolved.record.username,
        email: resolved.record.email,
        authToken: authToken,
        created: !!resolved.created,
        emailVerified: resolved.record.emailVerified !== false
      })
    };
  } catch (e) {
    console.error('register-account-passwordless: unexpected error', e);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E7: server_error' }) };
  }
};
