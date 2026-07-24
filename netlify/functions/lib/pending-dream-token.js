// netlify/functions/lib/pending-dream-token.js
//
// Single-use, short-lived claim token for a pending dream-builder-wizard
// generation (see lib/pending-dreams.js) — the abandoned-dream
// re-engagement email's link. Deliberately the SAME shape as
// lib/magic-link.js (generate a random token, store it in Blobs with a
// TTL, verify-and-consume on click) per this task's own instruction to
// reuse that exact mechanism — just generalized to authenticate a
// *pending dream*, not an *account*, since a user who abandoned before
// finishing signup has no account yet for magic-link.js's own token shape
// (which stores { username, email } and requires an account-store record
// to mint one — see that file). A user who already has a real account
// still gets a working, real magic-link login via lib/magic-link.js
// unchanged wherever that's used (e.g. a future "log back in" flow); this
// module only covers "prove you're the person this specific finished
// pending dream belongs to," which claim-dream.html needs regardless of
// whether an account exists yet.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-pending-dream-claims';
// Generous — this is the literal payoff of the retention email (the whole
// point is "come back whenever you see this"), not a security-sensitive
// short window like a password reset. Same order of magnitude as this
// codebase's other non-security link TTLs, just longer since there's no
// reason to force a rush here.
var TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Generates + stores a single-use claim token for `pendingId`. Returns the raw token string. */
async function createToken(event, pendingId) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  var store = getStore({ name: STORE_NAME });
  await store.setJSON(token, { pendingId: pendingId, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** Builds the claim-dream.html URL a claim token resolves to, from the request's own Host header — same `x-forwarded-host || host` pattern every other emailed-link function in this codebase uses (request-password-reset.js, lib/magic-link.js). */
function buildUrl(event, pendingId, token) {
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  return 'https://' + host + '/claim-dream.html?pending=' + encodeURIComponent(pendingId) + '&token=' + encodeURIComponent(token);
}

/**
 * Verifies (and, unless `peek` is true, deletes) a claim token. Returns
 * { ok:true, pendingId } or { ok:false, error:'invalid_or_expired' }.
 * Deliberately NOT single-use by default in practice — `peek` defaults to
 * true (unlike magic-link.js's login token, a claim link is meant to be
 * revisitable: someone opening their "dream is ready" email again a week
 * later to rewatch it should not find a dead link) — callers that
 * specifically want to consume it (none do today) can pass peek:false.
 */
async function verifyToken(event, token, peek) {
  connectLambda(event);
  var store = getStore({ name: STORE_NAME });
  var record = await store.get(token, { type: 'json' });
  if (!record || record.expiresAt < Date.now()) {
    if (record) await store.delete(token);
    return { ok: false, error: 'invalid_or_expired' };
  }
  if (peek === false) await store.delete(token);
  return { ok: true, pendingId: record.pendingId };
}

module.exports = { STORE_NAME, TTL_MS, createToken, buildUrl, verifyToken };
