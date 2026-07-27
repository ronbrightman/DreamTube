// netlify/functions/lib/session-transfer-token.js
//
// Single-use, ~15-minute token that lets a user who is ALREADY validly
// signed in (per this codebase's plaintext-local password-cache model —
// see js/store.js's login()/sendFirstDreamEmailBestEffort) carry that
// same session into a different browser context — specifically, escaping
// a Facebook/Instagram in-app webview via the host app's own "open in
// browser" action, which drops localStorage and therefore drops the
// session (see js/store.js's maintainSessionTransferUrl/
// consumeSessionTransferTokenFromUrlSync for the client side of this, and
// create-session-transfer.js/verify-session-transfer.js for the two
// endpoints that mint/consume tokens minted by this module).
//
// Deliberately mirrors lib/pending-dream-token.js's shape (random token,
// Blobs-backed, TTL) but consumed via the two-phase read->mutate->write
// ->verify pattern in lib/blobs-retry.js (like lib/pending-dreams.js's
// tryTransition / lib/entitlements.js's creditTokenPackOnce) rather than
// pending-dream-token.js's own plain read-then-delete — because THIS
// token grants a real logged-in session, a genuine double-consume under a
// race (two browser contexts both landing on the SAME ?bt= URL at nearly
// the same instant — plausible here specifically, since the whole point
// of this token is being embedded in a URL a host app hands off to a
// *different* browser process) would mean two different contexts both
// getting signed in from what must be a single-use handoff. See
// create-session-transfer.js's own header comment for why MINTING
// requires a real password check — this module itself does not verify
// identity at all, it only stores/consumes whatever {username,email} its
// caller already verified.
//
// Backed by a single Netlify Blobs store ("dreamtube-session-transfer"),
// one record per token: { username, email, createdAt, expiresAt,
// consumed, consumedAt, _consumeClaim }.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-session-transfer';
// Short, security-sensitive window — this token is a real, passwordless
// login credential for the ~15 minutes it's live (see create-session-
// transfer.js's own password-verified minting gate for why that's an
// acceptable, bounded risk given it only ever grants what a real password
// check already just confirmed) — NOT the generous 30-day claim-token TTL
// lib/pending-dream-token.js uses for its own, non-security, retention-
// email link.
var TTL_MS = 15 * 60 * 1000;

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Mints + stores a single-use transfer token for an ALREADY-VERIFIED
 * {username, email} pair. Returns the raw token string. Caller
 * (create-session-transfer.js) MUST have already confirmed this identity
 * via a real password check — this function trusts its input completely
 * and does no verification of its own.
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
 * Verifies and consumes `token`, EXACTLY once — see header comment for
 * why this needs blobs-retry's two-phase marker rather than a plain
 * read-then-delete. Returns { ok:true, username, email } the first (and
 * only) time a given token is successfully consumed while still within
 * its TTL; { ok:false } for anything else (unknown token, already
 * consumed, expired, or a losing racer against a concurrent consume of
 * the SAME token). Callers must treat every ok:false the same way: a
 * silent, no-error fall-through — never a distinct error surfaced to the
 * end user (see verify-session-transfer.js's own doc comment).
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
      // Unknown, already-consumed, or expired — all terminal: nothing
      // for THIS call to do, and retrying can't change any of them. See
      // blobs-retry.js's SKIP doc comment.
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
