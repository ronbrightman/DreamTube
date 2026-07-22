// netlify/functions/get-token-status.js
//
// GET ?email=... -> thin read-only wrapper around lib/entitlements.js's
// getTokenStatus, for client-side reads: profile.html's / style.html's /
// result.html's / processing.html's / shop.html's token balance + countdown
// UI (see those files, and js/store.js's getTokenStatus wrapper). The real,
// authoritative enforcement is still generate-video.js's server-side E112
// check — this endpoint only exists so the client has something to
// show/check without guessing. This is also the point that actually
// materializes a brand-new email's 200-token signup grant the *first* time
// it's ever read (see entitlements.js's syncTokens) — which is exactly why
// it's passed the real request `event`, not just the email string: the
// per-IP daily cap on new-signup-bonus grants needs the real client IP.
//
// No `email` (or one that normalizes to empty) resolves to a zero/inert
// status without ever touching Blobs, since there is nothing to look up —
// mirrors get-quota-status.js's old "no email -> nothing to show" shape,
// just without an `active` flag to key off of (tokens apply to every
// account, not just subscribers).
//
// Error codes (local to this function, same small-number-scheme as
// admin-paywall-toggle.js — a standalone function, not part of
// generate-video.js's E1xx chain):
//   E1 method_not_allowed

var entitlements = require('./lib/entitlements');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var rawEmail = (event.queryStringParameters && event.queryStringParameters.email) || '';
  if (!entitlements.normalizeEmail(rawEmail)) {
    return { statusCode: 200, body: JSON.stringify({ balance: 0, nextGrantAt: null, dailyGrantAmount: 100 }) };
  }

  var status = await entitlements.getTokenStatus(event, rawEmail);
  return { statusCode: 200, body: JSON.stringify(status) };
};
