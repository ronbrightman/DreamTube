// netlify/functions/facebook-oauth-callback.js
//
// GET ?code=...&state=...  ->  302 back into start.html, signed in.
//
// The server half of Facebook Login (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md,
// tracker items for-product-priority-founder-2026-07-30--ruzc5u and
// for-product-signup-screen-the-single-big-bkwhbe). The client half is
// js/facebook-config.js + start.html's screen 13.
//
// This is a BROWSER REDIRECT TARGET, not an API endpoint: Facebook sends
// the user's browser here as a top-level navigation, so every outcome —
// success and every failure alike — is a 302 back to start.html, never a
// JSON error body a human would ever see. Failures carry `?fb_error=<slug>`,
// which start.html renders as an inline message on screen 13 with the
// ordinary email/password fields left fully usable as a fallback (spec
// §2.4).
//
// WHY THE MANUAL/SERVER-SIDE FLOW AND NOT THE FACEBOOK JS SDK: the entire
// reason Facebook Login is the provider being built first is that
// DreamTube's paid traffic lives inside the FB/IG in-app webview, where
// popups are unreliable/blocked (and where Google's OAuth is hard-blocked
// outright). A popup-based SDK flow would fail hardest in exactly the
// context this feature exists for. See the spec's §1 for the citations.
//
// SECURITY BOUNDARY (read before changing anything here): the ONLY thing
// this endpoint ever trusts is what Facebook itself tells it over a
// server-to-server call made with FACEBOOK_APP_SECRET. `code` is not an
// identity — it is an opaque value exchanged for a token; the identity
// comes from graph.facebook.com/me, called with that token. Nothing about
// the user's identity is ever read from the query string, a cookie, or
// any client-supplied field. The `state`/cookie pair is used ONLY for
// CSRF and for reconstructing the funnel's own resume params — never for
// identity. Getting this backwards (e.g. trusting an `fbUserId` passed in
// the URL) would be a total account-takeover vector.
//
// Once identity is established, this mints a session-transfer token
// (lib/session-transfer-token.js, reused verbatim — the exact mechanism
// create-session-transfer.js already uses) and hands it back in the
// redirect as `?bt=`, which js/store.js's
// consumeSessionTransferTokenFromUrlSync exchanges for a real local
// session. That module deliberately performs no identity verification of
// its own — it trusts whatever minted the token — which is precisely why
// the identity resolution below must be airtight.
//
// IDENTITY RESOLUTION (spec §3, implemented in resolveIdentity below):
//   1. "f:<fbUserId>" hit                  -> LOGIN to that account.
//   2. else, Facebook returned an email:
//        - getByEmail hit                  -> LOGIN, upsert fbUserId once.
//                                             NEVER a duplicate account.
//        - miss                            -> CREATE {username derived,
//                                             password:null, email,
//                                             fbUserId}.
//   3. else (no email at all)              -> create NOTHING; mint a
//                                             lib/facebook-identity-token.js
//                                             marker and redirect with
//                                             ?fb_needs_email=<token> so
//                                             the client can ask for one
//                                             field. Completion happens in
//                                             facebook-complete-signup.js.
// The email index is the single source of truth for "does this person
// already have an account", whichever door they came through.
//
// FEATURE FLAG / FAIL CLOSED: with no FACEBOOK_APP_ID/FACEBOOK_APP_SECRET
// configured server-side this endpoint does nothing but redirect back
// with fb_error=not_configured. In practice it is unreachable in that
// state (js/facebook-config.js's placeholder means the button is never
// even rendered), but this is the defense-in-depth half of the same flag —
// same shape as generate-video.js's own server-side Turnstile check.
//
// Rate limiting: per-IP daily cap via lib/rate-limit.js, same shape as
// register-account.js's MAX_REGISTRATIONS_PER_IP_PER_DAY (this endpoint
// can create accounts, so it needs the same protection), tunable via
// MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY. No per-identifier bucket, for
// register-account.js's own stated reason: what's under contention is
// account creation in general, not one known identifier.
//
// Error slugs (surfaced as ?fb_error=<slug>; the numbering is this file's
// own local scheme, same convention as every other function here):
//   E1  method_not_allowed   — verb other than GET (no redirect; a real 405)
//   E2  not_configured       — FACEBOOK_APP_ID/SECRET unset server-side
//   E3  rate_limited         — per-IP daily cap exceeded
//   E4  denied               — user cancelled / declined at Facebook
//   E5  missing_code         — no `code` on the callback at all
//   E6  csrf                 — state missing/malformed, or nonce != cookie
//   E7  exchange_failed      — code -> access_token exchange failed
//   E8  profile_failed       — /me returned no usable `id`
//   E9  server_error         — anything else (store write failure, etc.)
//   E10 account_conflict     — resolution found a real but contradictory
//                              state (e.g. that Facebook id is already
//                              linked elsewhere); fails closed rather than
//                              guessing which account to sign in as.

var accountStore = require('./lib/account-store');
var sessionTransferToken = require('./lib/session-transfer-token');
var facebookIdentityToken = require('./lib/facebook-identity-token');
var deriveUsername = require('./lib/derive-username');
var rateLimit = require('./lib/rate-limit');
var crypto = require('crypto');

// Kept in sync by hand with js/facebook-config.js's FACEBOOK_GRAPH_VERSION
// — a browser script and a Node function can't share a constant in this
// codebase (no bundler/ES modules, see CLAUDE.md). Bump both together.
var GRAPH_VERSION = 'v21.0';
var GRAPH_HOST = 'https://graph.facebook.com';

var STATE_COOKIE = 'dt_fb_state';
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `x-forwarded-host || host`, this codebase's existing convention for reconstructing its own public origin inside a function (lib/dream-share-token.js's buildUrl, request-password-reset.js). */
function selfOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host || '';
  return 'https://' + host;
}

/** The redirect_uri, which MUST be byte-identical to the one the client put on the dialog URL (js/facebook-config.js's facebookRedirectUri) or Facebook refuses the token exchange. */
function redirectUri(event) {
  return selfOrigin(event) + '/.netlify/functions/facebook-oauth-callback';
}

/** Mirror of js/facebook-config.js's facebookBase64UrlEncode. */
function base64UrlDecode(value) {
  var b64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Decodes the `state` param into { nonce, resume }. Returns null for
 * anything that isn't a well-formed, non-empty payload — the caller treats
 * that exactly like a nonce mismatch (fail closed, E6), since a state we
 * can't read is a state we can't verify.
 */
function parseState(state) {
  if (!state) return null;
  try {
    var parsed = JSON.parse(base64UrlDecode(state));
    if (!parsed || typeof parsed.n !== 'string' || !parsed.n) return null;
    return { nonce: parsed.n, resume: typeof parsed.r === 'string' ? parsed.r : '' };
  } catch (e) {
    return null;
  }
}

/** Reads one cookie value out of the raw Cookie header. Netlify's Lambda-compatible event exposes headers lowercased, but both spellings are checked for the same reason lib/rate-limit.js's clientIp checks both. */
function readCookie(event, name) {
  var headers = (event && event.headers) || {};
  var raw = headers.cookie || headers.Cookie || '';
  var parts = String(raw).split(';');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    var eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) {
      try { return decodeURIComponent(part.slice(eq + 1)); } catch (e) { return part.slice(eq + 1); }
    }
  }
  return '';
}

/** Constant-time comparison of the state nonce against the cookie, so this check can't be narrowed by timing. Length mismatch short-circuits (lengths are not secret here — both are fixed-width hex from the same generator). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Builds the 302 back into the funnel. `resume` is whatever the client
 * packed into `state`; it always ends up carrying resume=1, because
 * start.html's own entry guard bounces any visit without it straight back
 * to the marketing funnel — a failure redirect that lost that param would
 * silently eject the user from the funnel entirely instead of showing
 * them an inline error.
 *
 * ALWAYS clears the CSRF cookie, on every outcome: it is single-use by
 * design, and leaving a live nonce sitting in the browser after the round
 * trip it was minted for is exactly the kind of thing a replay would want.
 */
function redirect(event, resume, extraParams) {
  var params = new URLSearchParams(resume || '');
  params.set('resume', '1');
  params.delete('bt');
  params.delete('fb_error');
  params.delete('fb_needs_email');
  Object.keys(extraParams || {}).forEach(function (key) {
    if (extraParams[key] !== null && extraParams[key] !== undefined) params.set(key, extraParams[key]);
  });
  return {
    statusCode: 302,
    headers: {
      Location: selfOrigin(event) + '/start.html?' + params.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': STATE_COOKIE + '=; path=/; max-age=0; SameSite=Lax; Secure'
    },
    body: ''
  };
}

function fail(event, resume, slug) {
  return redirect(event, resume, { fb_error: slug });
}

/**
 * Exchanges the one-time `code` for an app access token, server-to-server,
 * using FACEBOOK_APP_SECRET. Returns the token string or null — never
 * throws, and never surfaces Facebook's own error text to the browser
 * (it can contain app-identifying detail that has no business in a URL a
 * user can read/share).
 */
async function exchangeCodeForToken(event, code, appId, appSecret) {
  var url = GRAPH_HOST + '/' + GRAPH_VERSION + '/oauth/access_token' +
    '?client_id=' + encodeURIComponent(appId) +
    '&client_secret=' + encodeURIComponent(appSecret) +
    '&redirect_uri=' + encodeURIComponent(redirectUri(event)) +
    '&code=' + encodeURIComponent(code);
  try {
    var res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    var data = await res.json();
    return (data && typeof data.access_token === 'string' && data.access_token) ? data.access_token : null;
  } catch (e) {
    return null;
  }
}

/**
 * Fetches the Facebook profile. Returns { id, name, email } — `email` is
 * null whenever Facebook didn't hand one back.
 *
 * Per the spec's §3: Graph's /me only ever returns a CONFIRMED email;
 * there is no separate verified flag to check, and absence means "no
 * email available", never "unverified". An email is additionally required
 * to look like an email at all before it is ever used as an account key.
 */
async function fetchFacebookProfile(token) {
  var url = GRAPH_HOST + '/' + GRAPH_VERSION + '/me?fields=id,name,email&access_token=' + encodeURIComponent(token);
  try {
    var res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    var data = await res.json();
    if (!data || !data.id) return null;
    var email = (typeof data.email === 'string' && EMAIL_RE.test(data.email.trim())) ? data.email.trim() : null;
    return { id: String(data.id), name: typeof data.name === 'string' ? data.name : null, email: email };
  } catch (e) {
    return null;
  }
}

/**
 * The identity-resolution algorithm from the spec's §3, in one place so
 * it can be unit-tested directly (see
 * test/facebook-oauth-callback.test.js) rather than only through a full
 * redirect round trip.
 *
 * Returns one of:
 *   { outcome:'login',  record, created:false }
 *   { outcome:'signup', record, created:true }
 *   { outcome:'needs_email', fbUserId, name }
 *   { outcome:'error',  error }
 *
 * Never creates a second account for an email that already has one —
 * that invariant is the whole point of this function.
 */
async function resolveIdentity(event, profile) {
  var fbUserId = accountStore.normalizeFacebookUserId(profile.id);
  if (!fbUserId) return { outcome: 'error', error: 'invalid_facebook_id' };

  // 1. Already linked -> straight login, no email lookup needed at all.
  var byFacebook = await accountStore.getByFacebookUserId(event, fbUserId);
  if (byFacebook) return { outcome: 'login', record: byFacebook, created: false };

  // 3. (checked before 2 so the no-email case never touches the email
  //     index at all) No email -> create nothing, ask for one.
  if (!profile.email) {
    return { outcome: 'needs_email', fbUserId: fbUserId, name: profile.name || null };
  }

  // 2. Email is the single source of truth for "already has an account".
  var byEmail = await accountStore.getByEmail(event, profile.email);
  if (byEmail) {
    var linked = await accountStore.linkFacebookUserId(event, byEmail.username, fbUserId);
    if (!linked.ok) return { outcome: 'error', error: linked.error };
    return { outcome: 'login', record: linked.record, created: false };
  }

  return createFacebookAccount(event, fbUserId, profile.email, profile.name);
}

/**
 * The "brand-new account" branch, shared by resolveIdentity above and by
 * facebook-complete-signup.js's own needs-email completion — both create
 * exactly the same record shape, and factoring it here is what makes that
 * literally true rather than merely intended.
 *
 * password is null: this account has never had one. That is an existing,
 * accepted shape in this codebase, not a new one (js/store.js's
 * commitTransferredSession already materializes exactly it) — see the
 * spec's §3 for the one accepted v1 gap it implies (an FB-only account
 * can't yet do a manual password login on login.html).
 */
async function createFacebookAccount(event, fbUserId, email, name) {
  var derived = await deriveUsername.deriveAvailableUsername(email, async function (candidate) {
    return !!(await accountStore.getByUsername(event, candidate));
  });
  if (!derived.ok) return { outcome: 'error', error: derived.error };

  var created = await accountStore.createAccount(event, {
    username: derived.username,
    password: null,
    email: email,
    fbUserId: fbUserId
  });
  if (!created.ok) return { outcome: 'error', error: created.error };
  return { outcome: 'signup', record: created.record, created: true, name: name || null };
}

exports.handler = async function (event) {
  // Not a redirect — a browser never reaches this branch, only a
  // misconfigured caller would.
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var query = event.queryStringParameters || {};
  var parsedState = parseState(query.state);
  // Best-effort resume params for the redirect. Deliberately read BEFORE
  // the CSRF check passes, and used only to build a Location URL — never
  // for identity, never for anything with a side effect — so that even a
  // failure path can put the user back on their own dream rather than a
  // bare funnel entry.
  var resume = parsedState ? parsedState.resume : 'resume=1';

  var appId = process.env.FACEBOOK_APP_ID;
  var appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    return fail(event, resume, 'not_configured');
  }

  // Cheap shape checks first, THEN the rate limit, then the real work —
  // same ordering register-account.js uses (its E1-E6/E10 validation runs
  // before its E9 per-IP cap). Concretely this means a visitor who taps
  // Cancel at Facebook's dialog a few times doesn't burn their own daily
  // allowance on attempts that never touched Facebook's API at all.
  //
  // The user tapped Cancel / declined at Facebook's own dialog. Not an
  // error worth alarming language over — start.html shows the same
  // "continue with email below" fallback either way.
  if (query.error) {
    return fail(event, resume, 'denied');
  }
  if (!query.code) {
    return fail(event, resume, 'missing_code');
  }

  var maxPerDay = parseInt(process.env.MAX_FACEBOOK_CALLBACKS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 40;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'facebook-callback-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return fail(event, resume, 'rate_limited');
  }

  // CSRF: the nonce echoed back inside `state` must match the one this
  // browser was given in a first-party cookie moments before it left for
  // facebook.com. A missing/unparseable state is treated identically to a
  // mismatch — fail closed, always.
  if (!parsedState || !safeEqual(parsedState.nonce, readCookie(event, STATE_COOKIE))) {
    return fail(event, resume, 'csrf');
  }

  try {
    var accessToken = await exchangeCodeForToken(event, query.code, appId, appSecret);
    if (!accessToken) return fail(event, resume, 'exchange_failed');

    var profile = await fetchFacebookProfile(accessToken);
    if (!profile) return fail(event, resume, 'profile_failed');

    var resolved = await resolveIdentity(event, profile);

    if (resolved.outcome === 'needs_email') {
      var marker = await facebookIdentityToken.createToken(event, resolved.fbUserId, resolved.name);
      return redirect(event, resume, { fb_needs_email: marker });
    }
    if (resolved.outcome === 'error') {
      // 'facebook_id_taken' / 'account_already_linked' are real but
      // contradictory states (see lib/account-store.js's
      // linkFacebookUserId) — never guess which account to sign in as.
      var conflict = resolved.error === 'facebook_id_taken' || resolved.error === 'account_already_linked';
      return fail(event, resume, conflict ? 'account_conflict' : 'server_error');
    }

    // Reused verbatim from create-session-transfer.js: mint for the
    // RESOLVED record's own username/email, never anything client-supplied.
    var transfer = await sessionTransferToken.createToken(event, resolved.record.username, resolved.record.email || null);
    return redirect(event, resume, { bt: transfer, fb: resolved.created ? 'signup' : 'login' });
  } catch (e) {
    return fail(event, resume, 'server_error');
  }
};

// Exported for direct unit testing of the resolution algorithm (see
// test/facebook-oauth-callback.test.js) — the spec calls this out as
// genuinely security-sensitive logic that deserves coverage of its own,
// not just end-to-end coverage through a redirect.
exports._internal = {
  parseState: parseState,
  readCookie: readCookie,
  resolveIdentity: resolveIdentity,
  createFacebookAccount: createFacebookAccount
};
