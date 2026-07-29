// netlify/functions/save-push-subscription.js
//
// POST { username, subscription } -> durably records a Web Push
// subscription for `username` (netlify/functions/lib/push-subscription-
// store.js). Called by js/push-subscribe.js right after a successful
// `pushManager.subscribe()` — tracker item for-product-build-stage-0-pwa-
// web-push-f-jbutt5, part 3.
//
// IDENTITY MODEL: `username` is a bare client-supplied value, not verified
// against any session/password — this codebase has no server-side session
// at all (see lib/job-owners.js's own header comment on generate-video.js's
// identical email-as-identity precedent). This is a deliberately LIGHTER
// bar than create-session-transfer.js's real password check: the worst
// case of a forged username here is an unwanted push notification landing
// on the wrong (attacker-controlled) subscription for someone else's
// account — annoying, but not a money/account-takeover risk the way a
// forged session-transfer token would be, so this follows the SAME
// trust model every other client-identified write in this codebase uses
// (get-token-status.js, claim-daily-tokens.js, etc.), not a stricter one.
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields       — username/subscription not both present
//   E4 invalid_subscription — subscription missing endpoint/keys
//   E5 rate_limited

var pushSubscriptionStore = require('./lib/push-subscription-store');
var rateLimit = require('./lib/rate-limit');

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

  var username = (payload && payload.username) || '';
  var subscription = payload && payload.subscription;
  if (!username || !subscription) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: missing_fields' }) };
  }

  // Cheap per-IP hygiene against scripted abuse, same reasoning as every
  // other public unauthenticated endpoint in this codebase (see e.g.
  // create-session-transfer.js's own identical comment) — not the real
  // security boundary (there isn't a stronger one to have here, see
  // header comment), just bounding pointless request volume.
  var maxPerDay = parseInt(process.env.MAX_PUSH_SUBSCRIBE_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = 200;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'push-subscribe-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited' }) };
  }

  var result = await pushSubscriptionStore.addOrUpdateSubscription(event, username, subscription);
  if (!result.ok && result.error === 'invalid_subscription') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: invalid_subscription' }) };
  }
  if (!result.ok && result.error === 'invalid_subscription_keys') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: invalid_subscription' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: !!result.ok }) };
};
