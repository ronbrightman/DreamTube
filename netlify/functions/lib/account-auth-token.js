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
// supplied email, publish-dream.js's ownerHandle, etc.) — those keep their
// existing, already-documented tradeoffs. This exists narrowly for the one
// place a security review flagged as a real problem; expand its use
// deliberately, not by default.
//
// Backed by a single Netlify Blobs store ("dreamtube-account-auth-tokens"),
// one record per token: { username (normalized lowercase), createdAt,
// expiresAt }.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

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

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
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
    createdAt: Date.now(),
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
 */
async function verifyToken(event, token) {
  if (!token) return { ok: false };
  connectLambda(event);
  var record = await store().get(token, { type: 'json' });
  if (!record || record.expiresAt < Date.now()) return { ok: false };
  return { ok: true, username: record.username };
}

module.exports = { STORE_NAME, TTL_MS, mintToken, verifyToken };
