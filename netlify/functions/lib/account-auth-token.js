// netlify/functions/lib/account-auth-token.js
//
// Lightweight, reusable proof-of-identity token minted at the moment an
// account is REALLY, server-side verified — a successful password check
// (account-login.js) or a successful account creation (register-account.js)
// — for endpoints where trusting a bare client-supplied username is a real
// security problem, not just this early-beta app's usual honest MVP
// tradeoff. Built for block-user.js (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77, security review
// finding): GET/POST there act on a SAFETY mechanism (who you've blocked),
// so accepting a bare `username` string would let anyone who knows a
// victim's public handle enumerate their blocklist or silently unblock
// someone on their behalf — unlike, say, save-push-subscription.js's
// identical-looking bare-username trust, whose worst case is only a
// misdirected push notification (see that file's own header comment).
//
// Deliberately mirrors lib/dream-share-token.js/lib/session-transfer-
// token.js's established shape (random token, Blobs-backed, TTL,
// non-consuming verify) rather than inventing a new pattern — this
// codebase already solves "prove you are who you say without a real
// server session" this exact way in two other places. UNLIKE
// session-transfer-token.js (a short-lived, SINGLE-USE, must-be-consumed
// login handoff), this token is meant to be reusable for as long as the
// browser stays "signed in" the way this app already models that (no
// explicit logout-expires-token mechanism exists elsewhere either) — every
// call to verifyToken is non-consuming, same as dream-share-token.js's
// revisitable share link.
//
// NOT a general session-replacement for the rest of this codebase's many
// other client-trusted-identity call sites (generate-video.js's client-
// supplied email, etc.) — those keep their existing, already-documented
// tradeoffs. This exists narrowly for the places a security review flagged
// as a real problem; expand its use deliberately, not by default.
//
// SECOND USE (tracker item publish-dream-js-trusts-client-supplied--lkppcu,
// same "expand deliberately" reasoning as above): publish-dream.js/
// unpublish-dream.js now also require a verified token, for the same
// class of reason as block-user.js — a dream's public `id` gives anyone
// enough to forge a raw POST to either endpoint, and publish-dream.js's
// shared feed record started carrying real legal republish-consent state
// (channelLicenseGrantedAt/channelLicenseRevokedAt/okToFeatureOnChannels),
// making a bare client-supplied ownerHandle a real problem there too, not
// just honest MVP scope. verify-session-transfer.js also mints one now,
// on the same "a real password check already happened" basis as
// account-login.js/register-account.js — see that file's own header
// comment.
//
// IDENTITY-CUTOFF INVALIDATION (round-2 review finding, fixed): a token is
// bound to a username STRING at mint time, but a username isn't a stable
// identity forever — it can be freed and reassigned (delete-account.js's
// account-store.js has no cooldown on reusing a freed username) or have its
// password changed out from under a leaked/stolen token
// (verify-password-reset.js). Without this section, neither event ever
// revoked previously-minted tokens, which is a real, exploitable gap:
//   1. Password reset: someone who stole/leaked a token before the
//      legitimate user reset their password (specifically BECAUSE they
//      suspected compromise) would keep a fully working token for up to
//      the remaining 90-day TTL regardless.
//   2. Worse — full account-identity reuse: register a desirable username,
//      keep the minted token, delete that account, wait for a DIFFERENT
//      real person to register the SAME now-freed username, and the old
//      token would still verify — silently granting the original holder
//      read/write access to the NEW, unrelated account's blocklist
//      (enumerate their blocks, unblock people on their behalf), with zero
//      interaction from the new account holder at all.
//
// Fixed with a per-username CUTOFF timestamp (`invalidateTokensForUsername`,
// called by verify-password-reset.js's applyPasswordReset on a successful
// reset, and by delete-account.js on a successful deletion): verifyToken
// additionally checks the token's own `createdAt` against this cutoff, and
// rejects anything minted before it. Deliberately NOT a per-token
// revocation list (this codebase has no need for revoking one SPECIFIC
// token while leaving a user's other, equally-old tokens valid — every
// legitimate reason to invalidate here, a password reset or an account
// deletion, is a "this username's whole identity just changed underneath
// whatever was minted before" event, not a single-token concern) — a
// single cutoff record per username is the lightest correct fix: any token
// minted AFTER the cutoff (i.e. a fresh login/signup that happens moments
// later, including by a brand-new account reusing a freed username) is
// unaffected, since its own createdAt is necessarily later than the cutoff
// that was just set.
//
// SUB-MILLISECOND PRECISION for createdAt/cutoffAt (found while writing
// this fix's own tests, not just a theoretical worry): plain `Date.now()`
// only has 1ms resolution, so a mint and a same-username invalidate
// landing in the SAME millisecond would tie, and a strict `<` comparison
// leaves a tie non-invalidated -- a real correctness gap, not just a test
// artifact (this codebase's Blobs mock has ~zero latency, which is what
// first exposed it, but nothing here is Node-mock-specific; a real
// serverless invocation racing this closely, while unlikely given these
// are separate human-triggered HTTP round trips, isn't provably
// impossible either). `nowPrecise()` below uses
// `performance.timeOrigin + performance.now()` instead -- still a real
// wall-clock (Unix epoch) timestamp, so it's meaningfully comparable
// across the different Node processes separate Netlify Function
// invocations run in (unlike `process.hrtime()`, which is only monotonic
// within a single process and NOT comparable across invocations), just
// with sub-millisecond resolution, which shrinks the tie window from
// "one whole millisecond" to something no realistic pair of separate
// mint/invalidate calls will ever actually land on. Only used for
// createdAt/cutoffAt (the two values ever compared against each other);
// `expiresAt`'s plain-TTL check against `Date.now()` doesn't need this.
//
// Backed by a single Netlify Blobs store ("dreamtube-account-auth-tokens"):
//   - one record per TOKEN: { username (normalized lowercase), createdAt,
//     expiresAt }
//   - one record per USERNAME CUTOFF, key-prefixed to keep the two
//     namespaces apart (a real token is a 64-char hex string from
//     crypto.randomBytes(32), so an astronomically-unlikely collision with
//     a prefixed cutoff key isn't a real concern): { cutoffAt }

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var { performance } = require('perf_hooks');

/** Sub-millisecond-precision wall-clock timestamp (ms since Unix epoch, fractional) -- see this file's own SUB-MILLISECOND PRECISION header comment for why. */
function nowPrecise() {
  return performance.timeOrigin + performance.now();
}

var STORE_NAME = 'dreamtube-account-auth-tokens';
// Generous, "stay signed in" duration -- there's no periodic refresh/renew
// mechanism (this app's own state.user already persists indefinitely in
// localStorage with no expiry), so this is deliberately long rather than a
// short security-sensitive window like session-transfer-token.js's 15
// minutes: the actual sensitive action (a real password check or account
// creation) already happened before this token was ever minted; the token
// itself is just a durable receipt of that, re-minted on every future
// login/signup regardless. Whichever browser/account combination goes
// longer than this without a fresh login/signup simply stops being able to
// sync blocks server-side until its next one -- js/store.js's blockUser/
// unblockUser/syncBlockedHandlesFromServer already treat a missing/expired
// token as "skip the server sync, the local block still fully applies" (see
// that file's own doc comment), so an expired token here degrades gracefully
// rather than breaking anything.
var TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Key prefix for a username's cutoff record -- see this file's own
// IDENTITY-CUTOFF INVALIDATION header comment. Not a valid hex token
// shape, so it can never collide with a real minted token's own key.
var CUTOFF_KEY_PREFIX = '__cutoff__:';

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function cutoffKey(normalizedUsername) {
  return CUTOFF_KEY_PREFIX + normalizedUsername;
}

/**
 * Mints + stores a token bound to `username` (normalized). Returns the raw
 * token string. Callers (account-login.js on a real password-match
 * success, register-account.js on a real account-creation success) MUST
 * have already verified this identity themselves -- this function trusts
 * its input completely and does no verification of its own, same
 * "mint only after YOU verified it" contract as
 * lib/session-transfer-token.js's createToken.
 */
async function mintToken(event, username) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  await store().setJSON(token, {
    username: normalizeUsername(username),
    createdAt: nowPrecise(),
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

/**
 * Verifies `token`. Returns { ok:true, username } (the normalized
 * lowercase username it was minted for) or { ok:false }. Non-consuming --
 * safe to call on every request an already-signed-in browser makes, same
 * "revisitable" posture as lib/dream-share-token.js's verifyToken (NOT
 * lib/session-transfer-token.js's single-use verifyAndConsumeToken, which
 * exists for a different, must-only-ever-fire-once purpose).
 *
 * Also rejects a token minted BEFORE that username's own invalidation
 * cutoff, if one is on file (see invalidateTokensForUsername below and
 * this file's own IDENTITY-CUTOFF INVALIDATION header comment) -- this is
 * what makes a password reset or an account deletion actually revoke
 * every token minted before that moment, rather than a token surviving as
 * a durable, never-expiring proxy for an identity that no longer means
 * what it did when the token was minted.
 */
async function verifyToken(event, token) {
  if (!token) return { ok: false };
  connectLambda(event);
  var record = await store().get(token, { type: 'json' });
  if (!record || record.expiresAt < Date.now()) return { ok: false };

  var cutoff = await store().get(cutoffKey(record.username), { type: 'json' });
  if (cutoff && typeof cutoff.cutoffAt === 'number' && record.createdAt < cutoff.cutoffAt) {
    return { ok: false };
  }

  return { ok: true, username: record.username };
}

/**
 * Invalidates every token previously minted for `username` (normalized),
 * by recording the current time as that username's cutoff -- any token
 * whose own `createdAt` is before this moment fails verifyToken from now
 * on, permanently (a NEW token minted after this call, e.g. the very next
 * login, is naturally unaffected: its createdAt is necessarily later than
 * the cutoff just set). Call this on any event where a username's
 * underlying identity/credential just changed in a way that should
 * retroactively kill whatever was minted before it:
 *   - verify-password-reset.js's applyPasswordReset, on a successful
 *     password reset (closes the "stolen token survives a reset meant to
 *     lock them out" gap).
 *   - delete-account.js, on a successful account deletion (closes the
 *     "delete + let someone else register the freed username" identity-
 *     reuse gap -- see this file's own header comment for the full
 *     exploit shape this prevents).
 *
 * A no-op (but never throws) for an empty/invalid username -- there's
 * nothing meaningful to invalidate. Idempotent to call more than once in
 * quick succession (each call just moves the cutoff later, which can only
 * ever invalidate MORE, never fewer, previously-minted tokens).
 */
async function invalidateTokensForUsername(event, username) {
  var key = normalizeUsername(username);
  if (!key) return;
  connectLambda(event);
  await store().setJSON(cutoffKey(key), { cutoffAt: nowPrecise() });
}

module.exports = { STORE_NAME, TTL_MS, mintToken, verifyToken, invalidateTokensForUsername };
