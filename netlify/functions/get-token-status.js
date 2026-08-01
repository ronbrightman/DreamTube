// netlify/functions/get-token-status.js
//
// GET ?email=... -> thin read-only wrapper around lib/entitlements.js's
// getTokenStatus, for client-side reads: profile.html's / style.html's /
// result.html's / processing.html's / shop.html's / explore.html's token
// balance + claim UI (see those files, js/purchase-sheet.js, and
// js/store.js's getTokenStatus wrapper). The real, authoritative
// enforcement is still generate-video.js's server-side E112 check — this
// endpoint only exists so the client has something to show/check without
// guessing. This is also the point that actually materializes a brand-new
// email's 320-token signup grant the *first* time it's ever read (see
// entitlements.js's syncTokens) — which is exactly why it's passed the
// real request `event`, not just the email string: the per-IP daily cap on
// new-signup-bonus grants needs the real client IP. It does NOT, itself,
// ever claim the daily +20 — see claim-daily-tokens.js for that; this is a
// pure read (the `claimable` field it returns just projects whether a
// claim would currently succeed, see lib/entitlements.js's getTokenStatus
// doc comment).
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
    // dailyClaimAmount reads entitlements.js's real, live DAILY_CLAIM_AMOUNT
    // (20) rather than a hardcoded literal — this whole branch is a
    // no-Blobs-touch fast path (no email to look up), but there's no reason
    // it can't still read the live exported constant instead of
    // hand-maintaining its own stale copy. See tracker item
    // recurring-bug-class-hardcoded-daily-gran-h6swgy for why this exact bug
    // class keeps recurring across retunes. claimable is unconditionally
    // false here — there's no identity to claim anything against with no
    // known email. hasMadeFirstPurchase is unconditionally false too —
    // there's no identity here to have ever completed a purchase against,
    // so shop.html's first-purchase-bonus callout is safe to show (no false
    // claim risk with no known email).
    return { statusCode: 200, body: JSON.stringify({ balance: 0, claimable: false, nextClaimAt: null, dailyClaimAmount: entitlements.DAILY_CLAIM_AMOUNT, streak: 0, hasMadeFirstPurchase: false }) };
  }

  var status = await entitlements.getTokenStatus(event, rawEmail);
  return { statusCode: 200, body: JSON.stringify(status) };
};
