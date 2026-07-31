// netlify/functions/facebook-complete-signup.js
//
// POST { token, email } -> { ok:true, transferToken } — the completion
// half of Facebook Login's "needs email" edge case (docs/
// SIGNUP_FACEBOOK_LOGIN_SPEC.md §2.4 / §3 step 3).
//
// Reached only when facebook-oauth-callback.js confirmed WHO someone is
// (a real, server-verified Facebook user id from a server-to-server token
// exchange + /me call) but Facebook returned no email — the user declined
// the `email` permission, or has none on file. Rather than silently
// creating an email-less account (unreachable by every retention email
// this app sends, and invisible to the "e:" index that makes "same email
// = same account" work at all), that callback redirects back with an
// opaque marker (lib/facebook-identity-token.js) and start.html asks for
// one field. This endpoint is where that field is redeemed.
//
// THE SECURITY DECISION IN THIS FILE (read before changing anything): the
// email submitted here is TYPED BY THE USER and therefore NOT VERIFIED by
// anyone. So it may only ever CREATE a brand-new account. If the address
// already belongs to an existing account, this endpoint REFUSES (E5) — it
// does NOT link the Facebook identity onto that account and does NOT
// return a session for it. Linking on an unverified, self-asserted email
// would be a straightforward account-takeover: anyone with any Facebook
// account could decline the email permission, type a victim's address,
// and be handed a full session as that victim. This is exactly what the
// spec's §3 step 3 means by "defer creation until supplied, then run step
// 2's NOT FOUND branch" — the not-found branch only. The linking branch
// (step 2's "found") is reachable only from
// facebook-oauth-callback.js, where the email came from Facebook itself
// over a server-to-server call, never from a user's keyboard.
//
// The identity marker is consumed EXACTLY ONCE, immediately before the
// account is created — deliberately not before the validation checks
// above, so a typo'd or already-registered address leaves the marker
// alive for a retry instead of dead-ending the user back through the
// whole Facebook round trip. See lib/facebook-identity-token.js's
// peekToken doc comment.
//
// On success this mints a session-transfer token exactly the way
// facebook-oauth-callback.js does (lib/session-transfer-token.js, reused
// verbatim) and hands it back; the client then navigates to
// start.html?...&bt=<token>, so the "signed in and resumed" path is
// literally the same one code, with no second client-side
// session-commit primitive invented for this case.
//
// Error codes (local to this function, same small-number scheme as
// register-account.js/check-email.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 invalid_json        — POST body wasn't valid JSON
//   E3 missing_fields      — token/email not both present
//   E4 invalid_email       — not a plausible email address
//   E5 email_taken         — already registered; see the security note
//                             above. NEVER linked, never a session.
//   E6 invalid_or_expired  — unknown/expired/already-consumed marker
//   E7 rate_limited        — MAX_FACEBOOK_COMPLETIONS_PER_IP_PER_DAY
//   E8 create_failed       — account creation itself failed
//   E9 unexpected_error    — anything else (see the catch-all below)
//
// 200 { ok:false, error } is used for the normal business outcomes the
// client must branch on and render inline (E5/E6/E8), matching
// register-account.js's own E7/E8 convention; a real 4xx is reserved for
// a malformed request.

var accountStore = require('./lib/account-store');
var facebookIdentityToken = require('./lib/facebook-identity-token');
var sessionTransferToken = require('./lib/session-transfer-token');
var rateLimit = require('./lib/rate-limit');
var callback = require('./facebook-oauth-callback');

var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  var token = (payload.token || '').trim();
  var email = (payload.email || '').trim();
  if (!token || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }
  if (!EMAIL_RE.test(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_email' }) };
  }

  // Same per-IP daily cap shape as register-account.js — this endpoint
  // creates real accounts, so it gets the same protection.
  var maxPerDay = parseInt(process.env.MAX_FACEBOOK_COMPLETIONS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 20;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'facebook-complete-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E7: rate_limited' }) };
  }

  try {
    // Peek, don't consume yet — see the header comment.
    var peeked = await facebookIdentityToken.peekToken(event, token);
    if (!peeked.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired' }) };
    }

    // If this Facebook identity got linked to an account by some other
    // route while this marker was outstanding (a second, parallel login
    // that DID return an email), that account is the answer — this is a
    // login, and the typed email is simply irrelevant. Resolving here
    // rather than creating keeps the "never a duplicate" invariant true
    // even across concurrent round trips.
    var alreadyLinked = await accountStore.getByFacebookUserId(event, peeked.fbUserId);
    if (alreadyLinked) {
      var consumedExisting = await facebookIdentityToken.consumeToken(event, token);
      if (!consumedExisting.ok) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired' }) };
      }
      var existingTransfer = await sessionTransferToken.createToken(event, alreadyLinked.username, alreadyLinked.email || null);
      return { statusCode: 200, body: JSON.stringify({ ok: true, transferToken: existingTransfer, created: false }) };
    }

    // UNVERIFIED email -> create-only. See the header comment for why
    // this must never fall through to linkFacebookUserId.
    var existingByEmail = await accountStore.getByEmail(event, email);
    if (existingByEmail) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E5: email_taken' }) };
    }

    var consumed = await facebookIdentityToken.consumeToken(event, token);
    if (!consumed.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: invalid_or_expired' }) };
    }

    // Exactly the same creation path facebook-oauth-callback.js's own
    // brand-new-account branch takes — shared, not re-implemented, so the
    // two can't drift into producing different record shapes.
    var result = await callback._internal.createFacebookAccount(event, consumed.fbUserId, email, consumed.name);
    if (result.outcome !== 'signup') {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E8: create_failed' }) };
    }

    var transfer = await sessionTransferToken.createToken(event, result.record.username, result.record.email || null);
    return { statusCode: 200, body: JSON.stringify({ ok: true, transferToken: transfer, created: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E9: unexpected_error: ' + (e && e.message) }) };
  }
};
