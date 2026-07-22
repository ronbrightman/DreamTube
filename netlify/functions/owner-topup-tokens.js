// netlify/functions/owner-topup-tokens.js
//
// Resolves the "owner bypass for the token gate" question the founder's own
// way — NOT an E112 exemption for the owner's account (generate-video.js's
// gate stays unconditional for every email, owner included, see
// lib/entitlements.js's token-economy doc block), but a self-service way for
// the owner specifically to top up their own balance from profile.html's
// account sheet whenever they want to keep testing without waiting on the
// daily drip. See AGENT_POLICY.md / the founder's own explicit call on this.
//
// POST { email, amount } -> credits `amount` tokens directly onto that
//         email's balance via lib/entitlements.js's addTokens (see that
//         function for why this never touches lastGrantAt), but ONLY when
//         the given email (normalized) matches OWNER_EMAIL (normalized) —
//         otherwise 403. This is deliberately narrow: a self-service top-up
//         for the owner's own account, not a general "grant tokens to any
//         email" admin tool — there is no separate "target email" parameter,
//         the email being credited and the email being authorized are always
//         the same one. Returns the refreshed token status (same shape
//         get-token-status.js returns: { balance, nextGrantAt,
//         dailyGrantAmount }), so the client can redraw its balance from
//         this one response without a second round-trip — same pattern
//         grant-topup-bonus.js used to follow (see git history) before it
//         was removed in the token-economy pivot; this is a new function
//         built for the new model, not a resurrection of the old one (no
//         "TEMPORARY bypass" framing here — this really is the intended
//         mechanism, not a stand-in for a payment call that hasn't been
//         wired up yet).
//
// Same owner-check pattern as admin-paywall-toggle.js's POST: trusts
// client-supplied identity (the codebase's existing, documented tradeoff —
// see that file's own header comment for the full reasoning) rather than
// building real auth, but independently re-verifies the email server-side
// on every write regardless of anything the client claims or however
// profile.html decided whether to show the control at all.
//
// `amount` cap: rejects anything above MAX_AMOUNT_PER_CALL (5000) in one
// call. This is a basic sanity guard against a typo/fat-finger (e.g. an
// extra zero) — not a security boundary, since only the owner can ever
// reach this endpoint at all, and there is nothing stopping the owner from
// simply calling it again. It exists purely so a mistaken amount can't
// silently create an absurd balance in one shot.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js — a new, standalone function, not part of
// generate-video.js's E1xx/E2xx generation-flow chain):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 amount_invalid      — `amount` wasn't a positive integer, or exceeded
//                             MAX_AMOUNT_PER_CALL
//   E5 forbidden           — POST body's `email` (normalized) didn't match
//                             OWNER_EMAIL (normalized)

var entitlements = require('./lib/entitlements');

var MAX_AMOUNT_PER_CALL = 5000;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = entitlements.normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var amount = payload.amount;
  var isPositiveInteger = typeof amount === 'number' && Number.isInteger(amount) && amount > 0;
  if (!isPositiveInteger || amount > MAX_AMOUNT_PER_CALL) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: amount_invalid' }) };
  }

  var requestEmail = entitlements.normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E5: forbidden' }) };
  }

  await entitlements.addTokens(event, requestEmail, amount);
  var status = await entitlements.getTokenStatus(event, requestEmail);
  return { statusCode: 200, body: JSON.stringify(status) };
};
