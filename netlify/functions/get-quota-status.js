// netlify/functions/get-quota-status.js
//
// GET ?email=... -> thin read-only wrapper around lib/entitlements.js's
// getQuotaStatus, for client-side reads: profile.html's quota indicator,
// and the convenience pre-generation check on style.html/result.html before
// they navigate to processing.html (see those files, and js/store.js's
// getQuotaStatus wrapper). The real, authoritative enforcement is still
// generate-video.js's server-side E111 check — this endpoint only exists so
// the client has something to show/check without guessing.
//
// No `email` (or one that normalizes to empty) resolves to { active: false }
// without ever touching Blobs — matching every caller's existing "hide
// entirely when not an active subscriber" convention (see profile.html's
// #profile-insights for the same pattern already in this codebase).
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
    return { statusCode: 200, body: JSON.stringify({ active: false }) };
  }

  var status = await entitlements.getQuotaStatus(event, rawEmail);
  return { statusCode: 200, body: JSON.stringify(status) };
};
