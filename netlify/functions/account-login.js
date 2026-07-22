// netlify/functions/account-login.js
//
// POST { usernameOrEmail, password } -> the server-side login check, via
// lib/account-store.js. Resolves by username first, then by the email
// index, and checks the password against whatever account it finds. This
// is what makes login work from any device: js/store.js's login() calls
// this first now, instead of only ever checking the current browser's
// localStorage (see AGENT_POLICY.md / tracker.html's now-resolved
// accounts-dont-sync-across-devices item).
//
// Response shapes:
//   200 { ok:true, username, email }                — real match
//   200 { ok:false, error: 'E4: not_found' }          — no account under
//   200 { ok:false, error: 'E5: incorrect_password' }    that identifier
//                                                         server-side, or
//                                                         a wrong password
//   429 { ok:false, error: 'E6: rate_limited: ...' }  — see the rate-
//                                                        limiting doc block
//                                                        below. Deliberately
//                                                        ok:false (not just
//                                                        the bare {error:
//                                                        ...} shape generate-
//                                                        video.js/track-
//                                                        conversion.js use
//                                                        for their own 429s)
//                                                        so js/store.js's
//                                                        login() — which
//                                                        branches on data.ok,
//                                                        not on HTTP status —
//                                                        treats this as the
//                                                        real, deliberate
//                                                        rejection it is,
//                                                        never as
//                                                        "malformed
//                                                        response, fall back
//                                                        to local login"
//                                                        (see that
//                                                        function's own
//                                                        explicit rate_
//                                                        limited check).
// Same "business outcome, not a client error" reasoning as
// verify-password-reset.js's E4/register-account.js's E7/E8 — a login
// attempt that doesn't match anything is a completely normal, expected
// response the client needs to branch on (js/store.js's login() falls back
// to a legacy local-only check specifically on E4 not_found, never on E5 —
// see that file's own comment for why that distinction matters), not a
// malformed-request error.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as register-account.js/admin-paywall-toggle.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 invalid_json        — POST body wasn't valid JSON
//   E3 missing_fields      — usernameOrEmail/password not both present
//   E4 not_found           — no account matches that username or email
//   E5 incorrect_password  — account found, password didn't match it
//   E6 rate_limited        — MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY or
//                             MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY
//                             exceeded for today
//
// Rate limiting: this is a brand-new, fully anonymous endpoint that checks
// a caller-supplied password against a real account with zero throttling
// otherwise — same lib/rate-limit.js checkAndIncrement() helper generate-
// video.js/interpret-dream.js/track-conversion.js already use, but gated on
// TWO buckets rather than one: per-IP (same shape as everywhere else), AND
// per-identifier, since the risk here isn't just "one source hammering the
// endpoint" but specifically unlimited password-guessing against ONE known
// account — a per-IP cap alone doesn't stop that if the guesses are spread
// across IPs, and a per-identifier cap alone doesn't stop a single IP from
// spraying guesses across many identifiers. Both run unconditionally,
// before verifyLogin is ever called, so a request that's already over
// either cap never even reaches the account store. This also mitigates
// (doesn't eliminate — see the E4/E5 doc block above for why that
// distinction is kept) the account-enumeration angle: whatever an attacker
// could learn from E4 vs E5 across many attempts now costs a bounded, slow,
// detectable number of requests per day rather than being unlimited.
//
// The per-identifier bucket keys on the ACCOUNT the identifier resolves
// to (its canonical username), not the raw usernameOrEmail string —
// resolved via a lookup that mirrors verifyLogin's own username-then-email
// order, but deliberately never touches the password (rate limiting must
// gate BEFORE any password check runs). An attacker who knows both a
// target's username and email would otherwise get two independent buckets
// for the one account (one keyed on the username string, one on the email
// string) — effectively doubling the allowed daily guesses against that
// single account. Falls back to the lowercased raw identifier only when it
// doesn't resolve to any real account — there's no canonical account to
// share a bucket with in that case, and every nonexistent identifier
// getting its own bucket isn't a meaningful attack surface (no real
// account to protect there).

var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');

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

  var usernameOrEmail = (payload.usernameOrEmail || '').trim();
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_LOGIN_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 100;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_LOGIN_ATTEMPTS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 30;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'login-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many login attempts from this network today, try again tomorrow' }) };
  }
  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'login-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many login attempts for this account today, try again tomorrow' }) };
  }

  var result = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!result.ok) {
    var code = result.error === 'incorrect_password' ? 'E5: incorrect_password' : 'E4: not_found';
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: code }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, username: result.record.username, email: result.record.email }) };
};
