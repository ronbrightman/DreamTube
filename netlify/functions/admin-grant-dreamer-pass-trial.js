// netlify/functions/admin-grant-dreamer-pass-trial.js
//
// OWNER-ONLY manual activation of a Dreamer Pass TRIAL on a single account —
// the reliable fallback for when Dodo activated a subscription but the
// subscription.active webhook never reached / registered in our app (the
// live-webhook-not-subscribed-to-subscription-events gap the founder hit
// 2026-08-09; Dodo also offers no event resend for an event that wasn't
// subscribed at delivery time). Sets the account's subscription sub-object to
// `trialing` via lib/entitlements.js's own updateSubscription CAS writer, so
// getTokenStatus immediately reports the public trial shape and the 100/day
// claim boost turns on — exactly what a processed subscription.active would
// have done. Does NOT grant the 3,000 monthly tokens (a trial doesn't; the
// real 3,000 lands only on the first >$0 charge, via the webhook, once the
// subscription events are wired). trialEnd is left for updateSubscription's
// own TRIAL_WINDOW_MS fallback (now + 3 days) unless an explicit epoch-ms
// trialEnd is supplied.
//
// Same real-password + OWNER_EMAIL bar every other admin tool uses
// (verifyOwnerCredentials, identical shape to admin-reset-account-markers.js —
// see that file's header for the full reasoning) and the same per-IP daily
// rate limit. This is a genuine, if not cryptographically strong, boundary,
// the tradeoff already accepted across this codebase's admin surface.
//
// POST { usernameOrEmail, password, targetEmail, subscriptionId?, trialEndMs? }
//   -> { ok:true, subscription:<public shape>, dailyClaimAmount:<n> }
//   E1 method_not_allowed · E2 missing_owner_email · E3 invalid_json
//   E4 missing_fields (usernameOrEmail/password/targetEmail) · E5 forbidden
//   E6 rate_limited · E7 update_failed

var entitlements = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');
var { normalizeEmail } = entitlements;

async function verifyOwnerCredentials(event, usernameOrEmail, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };
  var loginCheck = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };
  if (normalizeEmail(loginCheck.record.email) !== ownerEmail) return { ok: false, error: 'not_owner' };
  return { ok: true, record: loginCheck.record };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }
  var payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) }; }

  var usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
  var password = typeof payload.password === 'string' ? payload.password : '';
  var targetEmail = normalizeEmail(payload.targetEmail);
  if (!usernameOrEmail || !password || !targetEmail) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_GRANT_TRIAL_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 100;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-grant-dreamer-pass-trial-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var subscriptionId = typeof payload.subscriptionId === 'string' && payload.subscriptionId.trim()
    ? payload.subscriptionId.trim() : undefined;
  var trialEndMs = Number(payload.trialEndMs);
  var patch = {
    status: 'trialing',
    subscriptionId: subscriptionId,
    productId: process.env.DODO_PRODUCT_DREAMER_PASS || undefined,
    // Left undefined -> updateSubscription caps to now + TRIAL_WINDOW_MS (3d);
    // an explicit future epoch-ms overrides that.
    trialEnd: (trialEndMs > Date.now()) ? trialEndMs : undefined
  };

  try {
    await entitlements.updateSubscription(event, targetEmail, patch);
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'E7: update_failed: ' + (e && e.message ? e.message : 'unknown') }) };
  }

  var status = await entitlements.getTokenStatus(event, targetEmail);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      email: targetEmail,
      subscription: status.subscription,
      dailyClaimAmount: status.dailyClaimAmount
    })
  };
};
