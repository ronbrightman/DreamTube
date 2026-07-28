// netlify/functions/owner-topup-tokens.js
//
// Resolves the "owner bypass for the token gate" question the founder's own
// way — NOT an E112 exemption for the owner's account (generate-video.js's
// gate stays unconditional for every email, owner included, see
// lib/entitlements.js's token-economy doc block), but a self-service way for
// the owner specifically to top up their own balance from profile.html's
// account sheet whenever they want to keep testing without waiting on the
// daily claim's 20h cooldown. See AGENT_POLICY.md / the founder's own
// explicit call on this.
//
// POST { email, amount, targetUsername? } -> credits `amount` tokens onto
//         a balance via lib/entitlements.js's addTokens (see that function
//         for why this never touches lastClaimAt/streak), but ONLY when the
//         REQUESTING `email` (normalized) matches OWNER_EMAIL (normalized)
//         — otherwise 403. AUTHORIZATION IS UNCHANGED from this file's
//         original, narrower shape: it is always the requester's own
//         identity that has to match OWNER_EMAIL, exactly as before this
//         `targetUsername` parameter was added — nothing about that check
//         (below, still `requestEmail !== ownerEmail`) was touched. What
//         changed is WHICH ACCOUNT GETS CREDITED once that authorization
//         passes:
//           - `targetUsername` omitted/blank (the original, still-default
//             behavior): credits the same `email` that was just verified
//             against OWNER_EMAIL — i.e. self-top-up, byte-for-byte the
//             same as before this parameter existed.
//           - `targetUsername` present: resolves it to an email via
//             lib/account-store.js's getByUsername (the same server-side
//             account store admin-rename-account.js already uses to
//             resolve a username to its on-file record — reused here, not
//             reimplemented) and credits THAT email instead. 404s with
//             E6 if no account exists under that username — this can never
//             silently no-op or fall back to crediting the owner instead.
//         This still isn't a general "grant tokens to any email" admin
//         tool in the sense of being reachable by anyone — it's reachable
//         by exactly the same one caller as before (the verified owner),
//         who can now direct a credit at a named recipient account instead
//         of only ever their own. See tracker item
//         for-product-extend-owner-top-up-with-a-t-2hmopn (founder-
//         approved 2026-07-28: a one-off 800-token gift to his son's
//         account, username benbrightman14) for why this was extended.
//         Returns the refreshed token status of the CREDITED account (same
//         shape get-token-status.js returns: { balance, claimable,
//         nextClaimAt, dailyClaimAmount, streak, hasMadeFirstPurchase }),
//         plus `creditedEmail`/`targetUsername` so a caller crediting a
//         target account can tell (and log) whose balance this response
//         actually describes, rather than assuming it's always the
//         requester's own — same pattern grant-topup-bonus.js used to
//         follow (see git history) before it was removed in the
//         token-economy pivot; this is a new function built for the new
//         model, not a resurrection of the old one.
//
// Same owner-check pattern as admin-paywall-toggle.js's POST: trusts
// client-supplied identity (the codebase's existing, documented tradeoff —
// see that file's own header comment for the full reasoning) rather than
// building real auth, but independently re-verifies the REQUESTING email
// server-side on every write regardless of anything the client claims or
// however profile.html decided whether to show the control at all. This
// weak-boundary tradeoff is deliberately NOT strengthened here — extending
// what an already-authorized owner can direct their own top-up at is not
// the same thing as widening who can reach this endpoint at all, and this
// change doesn't touch that boundary either way.
//
// `amount` cap: rejects anything above MAX_AMOUNT_PER_CALL (5000) in one
// call. This is a basic sanity guard against a typo/fat-finger (e.g. an
// extra zero) — not a security boundary, since only the owner can ever
// reach this endpoint at all, and there is nothing stopping the owner from
// simply calling it again. It exists purely so a mistaken amount can't
// silently create an absurd balance in one shot. Applies identically
// whether the credit lands on the owner's own account or a named target.
//
// Race protection: this still calls entitlements.js's addTokens exactly as
// before — a single plain, unretried setEntitlement write, NOT wrapped in
// lib/blobs-retry.js's read->mutate->write->verify loop. That's existing,
// documented precedent (see entitlements.js's own "Residual, undefended
// race" note on creditTokenPackAmountOnce, which calls out this exact
// owner-topup-tokens.js call site as an accepted plain write), not a gap
// newly introduced by adding `targetUsername` — this function still only
// ever performs one single top-up write per call, same as before, just
// possibly against a different key. blobs-retry.js's stronger guarantee
// exists for genuinely concurrent/idempotency-sensitive writers (a webhook
// that can be redelivered, two near-simultaneous requests for the same
// key) — a manual, one-off owner-initiated top-up (self or gifted) has
// neither property, so no new protection is warranted here.
//
// One thing THIS parameter does change about that same tradeoff (review
// finding, worth flagging explicitly rather than leaving implicit): the
// original "residual, undefended race" reasoning was written when the
// unretried write could only ever race the OWNER's own concurrent
// activity (their own testing). A gifted `targetUsername` credit can now
// race a REAL end user's own concurrent activity instead — a live
// generation spend or a due daily-grant sync on their own session,
// clobbering via last-write-wins. Still accepted as-is: this remains a
// manual, low-frequency admin action, not automated/looped, so the
// exposure window per gift is tiny — but if that frequency or blast
// radius ever grows, route this specific credit through
// lib/blobs-retry.js the way creditTokenPackAmountOnce already does,
// rather than assuming the original reasoning still fully covers it.
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
//                             OWNER_EMAIL (normalized) — this is always the
//                             REQUESTER's identity, regardless of what
//                             targetUsername (if any) was also sent
//   E6 target_account_not_found — `targetUsername` was given but no account
//                             is registered under it (lib/account-store.js's
//                             getByUsername came back empty) — nothing is
//                             credited when this fires

var entitlements = require('./lib/entitlements');
var accountStore = require('./lib/account-store');

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

  // Authorization above is unconditional and already decided by this point
  // — everything below only decides WHICH account the now-authorized
  // owner's credit lands on, never whether they're allowed to credit at
  // all (see header comment).
  var targetUsername = typeof payload.targetUsername === 'string' ? payload.targetUsername.trim() : '';
  var creditedEmail = requestEmail; // default: self-top-up, unchanged from before targetUsername existed

  if (targetUsername) {
    var targetAccount = await accountStore.getByUsername(event, targetUsername);
    if (!targetAccount) {
      return { statusCode: 404, body: JSON.stringify({ error: 'E6: target_account_not_found' }) };
    }
    creditedEmail = entitlements.normalizeEmail(targetAccount.email);
  }

  await entitlements.addTokens(event, creditedEmail, amount);
  var status = await entitlements.getTokenStatus(event, creditedEmail);
  var body = Object.assign({}, status, {
    creditedEmail: creditedEmail,
    targetUsername: targetUsername || null
  });
  return { statusCode: 200, body: JSON.stringify(body) };
};
