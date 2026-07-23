// netlify/functions/lib/magic-link.js
//
// Shared token generation/storage for the email magic-link login (see
// ../request-magic-link.js / ../verify-magic-link.js) AND for the SMS
// day-1 reminder's link — ../schedule-reminder.js reuses this exact same
// token mechanism for the link inside the text (see
// docs/IDENTITY_RETENTION_PROJECT_SPEC.md Section 1.3, "The SMS body
// includes a magic-link URL, generated the same way as 1.2"). Same shape
// as request-password-reset.js/verify-password-reset.js's reset-token
// store, just a separate Blobs store/TTL and a "log in" outcome instead
// of "show the set-new-password form".

var { connectLambda, getStore } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-magic-links';
// 10-15 minutes per the spec — 15 chosen as the more forgiving end, same
// "real inbox-check delay, not a security-critical window" reasoning
// request-password-reset.js's own 30-minute reset window documents.
var TTL_MS = 15 * 60 * 1000;

/**
 * Generates + stores a single-use magic-link token for `record` (an
 * account-store.js record — only its username/email are kept in the
 * token record). Returns the raw token string; the caller builds
 * whatever URL it needs around it (login.html?magic=<token> for the
 * email flow and the SMS body alike — see buildUrl below).
 */
async function createToken(event, record) {
  var token = crypto.randomBytes(32).toString('hex');
  connectLambda(event);
  var store = getStore(STORE_NAME);
  await store.setJSON(token, {
    username: record.username,
    email: record.email,
    expiresAt: Date.now() + TTL_MS
  });
  return token;
}

/** Builds the login.html URL a magic-link token resolves to, from the request's own Host header — same `x-forwarded-host || host` pattern request-password-reset.js's resetUrl already uses. */
function buildUrl(event, token) {
  var host = event.headers['x-forwarded-host'] || event.headers.host;
  return 'https://' + host + '/login.html?magic=' + token;
}

/**
 * Verifies (and, if `consume` is true, deletes) a magic-link token.
 * Returns { ok:true, username, email } or
 * { ok:false, error:'invalid_or_expired' }. Mirrors
 * verify-password-reset.js's peek/consume shape.
 */
async function verifyToken(event, token, consume) {
  connectLambda(event);
  var store = getStore(STORE_NAME);
  var record = await store.get(token, { type: 'json' });
  if (!record || record.expiresAt < Date.now()) {
    if (record) await store.delete(token); // expired — clean it up while we're here
    return { ok: false, error: 'invalid_or_expired' };
  }
  if (consume) await store.delete(token);
  return { ok: true, username: record.username, email: record.email };
}

module.exports = { STORE_NAME, TTL_MS, createToken, buildUrl, verifyToken };
