// netlify/functions/lib/email-login-token.js
//
// Single-use, 7-day token that turns a RETENTION/RECOVERY email link into a
// one-tap login (founder decision 2026-08-15: "make the recovery/return
// emails auto-login"). It is the long-lived sibling of lib/session-transfer-
// token.js: that token is a ~15-minute in-flight handoff (webview -> real
// browser, or the verify-email-link redirect), consumed seconds after it is
// minted; THIS token is minted at EMAIL-SEND time and dereferenced whenever
// the human actually opens the email — minutes, hours, or a day or two
// later — so a 15-minute TTL would be expired for essentially every real
// recipient (they don't read email in 15 minutes). It therefore needs its
// own, generous TTL and its own store.
//
// SECURITY MODEL — this is a magic-login link, exactly like verify-email-
// link.js's mailed link: possession of the email IS the auth factor. To keep
// that bounded the token is (1) SINGLE-USE — consumed on first tap via the
// same lib/blobs-retry.js two-phase read->mutate->write->verify pattern
// session-transfer-token.js uses, so a forwarded/leaked link logs in at most
// once — and (2) TTL-bounded to 7 days. It does NOT itself verify identity;
// like session-transfer-token.js it stores/consumes whatever {username,email}
// its caller (the email sender, for an account it already resolved) hands it.
//
// The consuming endpoint (email-login.js) does NOT hand this raw token to the
// browser as the session credential — it consumes this token server-side and
// then mints a FRESH lib/session-transfer-token.js token for the actual
// ?bt= client handoff, so the short-lived, security-sensitive credential the
// browser ever sees is unchanged from every other login path.
//
// Backed by a single Netlify Blobs store ("dreamtube-email-login"), one
// record per token: { username, email, createdAt, expiresAt, consumed,
// consumedAt, _consumeClaim }.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-email-login';
// Generous, retention-email-appropriate window (like lib/pending-dream-
// token.js's non-security link TTL, NOT session-transfer-token.js's 15-min
// security window) — the human reads the email on their own schedule. Still
// single-use, so the bounded risk is "a leaked link works once within 7 days"
// rather than "a real password check just happened."
var TTL_MS = 7 * 24 * 60 * 60 * 1000;

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Mints + stores a single-use email-login token for an ALREADY-RESOLVED
 * {username, email} pair (the sender looked the account up before calling).
 * Returns the raw token string. Trusts its input completely and does no
 * identity verification of its own — the mailed link's possession is the gate.
 */
async function createToken(event, username, email) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  await store().setJSON(token, {
    username: username,
    email: email || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    consumed: false,
    consumedAt: null
  });
  return token;
}

var MAX_CONSUME_ATTEMPTS = 3;

/**
 * Verifies and consumes `token`, EXACTLY once — same two-phase marker as
 * session-transfer-token.js (a login credential must never double-consume
 * under a race). Returns { ok:true, username, email } the first and only
 * time a given token is consumed while still within its TTL; { ok:false }
 * for anything else (unknown, already consumed, expired, or a losing racer).
 * Callers treat every ok:false the same way: a silent fall-through to the
 * normal signed-out flow, never a distinct error surfaced to the user.
 */
async function verifyAndConsumeToken(event, token) {
  if (!token) return { ok: false };
  var claim; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, token, {
    maxAttempts: MAX_CONSUME_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(token, { type: 'json' }).then(function (v) { return v || null; });
    },
    mutate: function (existing) {
      // Unknown, already-consumed, or expired — all terminal; retrying can't
      // change any of them (see blobs-retry.js's SKIP doc comment).
      if (!existing) return blobsRetry.SKIP;
      if (existing.consumed) return blobsRetry.SKIP;
      if (existing.expiresAt < Date.now()) return blobsRetry.SKIP;

      claim = crypto.randomBytes(12).toString('hex');
      return Object.assign({}, existing, { consumed: true, consumedAt: Date.now(), _consumeClaim: claim });
    },
    verify: function (verifyRead) {
      return !!(verifyRead && verifyRead._consumeClaim === claim);
    }
  });

  if (!result.ok) return { ok: false };
  return { ok: true, username: result.value.username, email: result.value.email };
}

module.exports = { STORE_NAME, TTL_MS, createToken, verifyAndConsumeToken };
