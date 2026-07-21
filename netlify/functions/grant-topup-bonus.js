// netlify/functions/grant-topup-bonus.js
//
// ============================================================================
// TEMPORARY PAYWALL BYPASS — READ BEFORE TOUCHING
// ----------------------------------------------------------------------------
// No payment provider/price has been chosen for top-up bundles (still a
// human/vendor decision — see AGENT_POLICY.md's escalation policy; that's
// not something a build pass makes). This function grants `bundleSize`
// bonus generations directly onto the caller's entitlement record — NO real
// charge, NO vendor call of any kind — purely so the top-up UI (profile.html's
// quota indicator, the quota-block modal + top-up sheet on style.html/
// result.html, and processing.html's E111 fail-state) has something real to
// call end-to-end while that vendor decision is pending. This mirrors
// start.html's proceedPastPricing() bypass exactly — same reasoning, same
// "do not mistake this for done" warning. Replace this function's body with
// a real Dodo Checkout call the moment a provider/price is picked for top-up
// bundles specifically. Do not build that real call here without that human
// decision having happened first.
// ============================================================================
//
// POST { email, bundleSize } -> increments that email's entitlement record's
// bonusCredits by bundleSize (see lib/entitlements.js — bonusCredits never
// expires, never resets on the monthly quota rollover) and returns the
// account's refreshed quota status (same shape get-quota-status.js returns),
// so a caller can redraw its quota UI from this one response without a
// second round trip.
//
// Error codes (local to this function, same small-number-scheme as
// admin-paywall-toggle.js — a standalone function, not part of
// generate-video.js's E1xx chain):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 email_required
//   E4 bundle_size_must_be_a_positive_integer

var entitlements = require('./lib/entitlements');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var email = entitlements.normalizeEmail(payload.email);
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: email_required' }) };
  }

  var bundleSize = parseInt(payload.bundleSize, 10);
  if (!bundleSize || bundleSize <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: bundle_size_must_be_a_positive_integer' }) };
  }

  var existing = await entitlements.getEntitlement(event, email);
  var currentBonus = (existing && typeof existing.bonusCredits === 'number') ? existing.bonusCredits : 0;
  await entitlements.setEntitlement(event, email, { bonusCredits: currentBonus + bundleSize });

  var status = await entitlements.getQuotaStatus(event, email);
  return { statusCode: 200, body: JSON.stringify(status) };
};
