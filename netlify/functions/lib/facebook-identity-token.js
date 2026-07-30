// netlify/functions/lib/facebook-identity-token.js
//
// The "needs email" half-step of Facebook Login (docs/
// SIGNUP_FACEBOOK_LOGIN_SPEC.md §2.4 / §3 step 3): Facebook has confirmed
// WHO this person is (a real, server-verified `fbUserId`, obtained from a
// server-to-server token exchange + /me call in
// facebook-oauth-callback.js) but returned NO email — either the user
// declined the `email` permission, or their Facebook account genuinely
// has no confirmed address on file. That is a temporarily INCOMPLETE
// identity: there is enough to know who they are, not enough to create
// the account, because email is this app's actual delivery channel AND
// the single source of truth for "does this person already have an
// account" (see lib/account-store.js's "e:" index).
//
// The spec's requirement is a "signed, tamper-proof marker referencing
// the already-verified fbUserId" that survives a redirect back into
// start.html, so the client can ask for one more field and then complete
// creation through the same fbUserId-carrying path.
//
// WHY A BLOBS-BACKED RANDOM TOKEN AND NOT AN HMAC-SIGNED PAYLOAD: this
// codebase already has an established primitive for exactly this shape,
// used three times over — lib/session-transfer-token.js,
// lib/dream-share-token.js and lib/pending-dream-token.js — "generate an
// unguessable random token, store the real data server-side in Blobs
// under it with a TTL, verify on read." dream-share-token.js's own header
// comment states the principle directly: "the token is what's never
// client-forgeable ... not the data it points at." That gives strictly
// stronger tamper-resistance than a signed payload here, because the
// fbUserId never leaves the server at all — there is no payload in the
// URL to tamper with, forge, or replay against a different identity, and
// nothing for a new signing-key primitive (which this codebase does not
// otherwise have) to get wrong.
//
// Which of the three existing token libs this mirrors, and why:
// session-transfer-token.js, not the other two. This token is
// security-sensitive in the same way that one is — redeeming it CREATES a
// real account and hands back a real session — so it takes that file's
// short TTL and, critically, its two-phase blobs-retry consume rather
// than dream-share-token.js's freely-revisitable `peek` semantics or
// pending-dream-token.js's plain read-then-delete. A double-consume here
// would mean one Facebook round trip yielding two account-creation
// attempts.
//
// Backed by a single Netlify Blobs store
// ("dreamtube-facebook-identity"), one record per token:
// { fbUserId, name, createdAt, expiresAt, consumed, consumedAt,
//   _consumeClaim }.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-facebook-identity';

// Same 15-minute window, and the same reasoning, as
// lib/session-transfer-token.js: this is a live credential for creating
// an account as a Facebook-verified identity, so it gets a short,
// security-sensitive TTL — not lib/dream-share-token.js's generous
// 30-day retention-email figure. Long enough for a real person to type an
// email address into one field; short enough that a token left sitting in
// a browser history entry is dead by the time anyone finds it.
var TTL_MS = 15 * 60 * 1000;

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Mints + stores a token for an ALREADY-VERIFIED Facebook identity.
 * Caller (facebook-oauth-callback.js) MUST have completed the real
 * server-to-server code->token exchange and /me call before calling this
 * — this function trusts its input completely and verifies nothing.
 * `name` is carried only so the completion step could greet the user by
 * name; it is never used for identity.
 */
async function createToken(event, fbUserId, name) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  await store().setJSON(token, {
    fbUserId: String(fbUserId),
    name: name || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
    consumed: false,
    consumedAt: null
  });
  return token;
}

/**
 * Reads a token WITHOUT consuming it. Returns { ok:true, fbUserId, name }
 * or { ok:false }.
 *
 * This exists so facebook-complete-signup.js can validate the submitted
 * email (format, and "is this address already registered") BEFORE burning
 * the single-use token — otherwise a user who mistypes their address, or
 * types one that already has an account, would be dead-ended and forced
 * back through the whole Facebook round trip to try again. Consumption
 * still happens exactly once, immediately before the account is created
 * (see consumeToken below), so the single-use guarantee is unchanged for
 * every path that actually results in an account.
 */
async function peekToken(event, token) {
  if (!token) return { ok: false };
  connectLambda(event);
  var record = await store().get(token, { type: 'json' });
  if (!record) return { ok: false };
  if (record.consumed) return { ok: false };
  if (record.expiresAt < Date.now()) return { ok: false };
  return { ok: true, fbUserId: record.fbUserId, name: record.name };
}

var MAX_CONSUME_ATTEMPTS = 3;

/**
 * Verifies and consumes `token`, EXACTLY once — byte-for-byte the same
 * two-phase read->mutate->write->verify shape as
 * lib/session-transfer-token.js's verifyAndConsumeToken, for the same
 * reason (see this file's header comment): a losing racer must get
 * { ok:false }, never a second successful consume. Returns
 * { ok:true, fbUserId, name } the first and only time, { ok:false } for
 * anything else (unknown, already consumed, expired, or a lost race).
 */
async function consumeToken(event, token) {
  if (!token) return { ok: false };
  var claim; // set fresh inside mutate() on whichever attempt actually writes

  var result = await blobsRetry.retryingWrite(event, STORE_NAME, token, {
    maxAttempts: MAX_CONSUME_ATTEMPTS,
    read: function (evt) {
      connectLambda(evt);
      return store().get(token, { type: 'json' }).then(function (v) { return v || null; });
    },
    mutate: function (existing) {
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
  return { ok: true, fbUserId: result.value.fbUserId, name: result.value.name };
}

module.exports = { STORE_NAME, TTL_MS, createToken, peekToken, consumeToken };
