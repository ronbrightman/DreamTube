// netlify/functions/save-whatsapp-number.js
//
// GET  ?username=...             -> { ok:true, whatsappNumber: string|null }
// POST { username, whatsappNumber } -> saves (whatsappNumber non-empty) or
//         clears (whatsappNumber omitted/empty string) the WhatsApp
//         morning-capture opt-in number on that account's server-side
//         record (lib/account-store.js's whatsappNumber field, via that
//         file's setWhatsappNumber). Backs profile.html's Settings ->
//         "Morning WhatsApp reminder" section (tracker item for-product-
//         build-whatsapp-morning-captu-skez3n, step 3).
//
// WHY A SETTINGS-PAGE OPT-IN, NOT REVIVING wizard.html's PARKED FIELD: see
// profile.html's own comment at the top of that settings-section for the
// full reasoning — short version, this is a lower-friction, lower-risk ask
// of an ALREADY-signed-up user, not a second field competing for attention
// during the one-shot signup funnel that field was deliberately hidden
// from (tracker items for-product-hide-the-whatsapp-field-in-w-clu9ju /
// for-ron-reminder-complete-the-whatsapp-c-9mz857).
//
// IDENTITY MODEL: same bare-client-supplied-username trust as
// save-push-subscription.js (see that file's own header comment for the
// fuller reasoning) — this app has no server-side session at all. The
// worst case of a forged/guessed username here is an unwanted WhatsApp
// opt-in (or a wrong number) landing on someone else's account — annoying,
// not a money/account-takeover risk — so this follows the SAME lighter
// trust tier every other client-identified write in this codebase uses
// (get-token-status.js, save-push-subscription.js, etc.), not
// account-auth-token.js's stronger, token-verified tier (built for
// block-user.js/publish-dream.js, which hold real safety/consent state —
// see that file's own header comment on why those two needed it and this
// class of write doesn't).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 missing_fields   -- username not present (GET or POST)
//   E4 invalid_number   -- POST's whatsappNumber was non-empty but not a
//                           valid E.164 number (account-store.js's
//                           normalizeWhatsappNumber)
//   E5 rate_limited
//   E6 not_found        -- no account under that username

var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');

var MAX_PER_IP_PER_DAY_DEFAULT = 200;

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var queryUsername = (event.queryStringParameters && event.queryStringParameters.username) || '';
    if (!queryUsername) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: missing_fields' }) };
    }
    var existing = await accountStore.getByUsername(event, queryUsername);
    return { statusCode: 200, body: JSON.stringify({ ok: true, whatsappNumber: (existing && existing.whatsappNumber) || null }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E2: invalid_json' }) };
  }

  var username = (payload && payload.username) || '';
  if (!username) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E3: missing_fields' }) };
  }
  var whatsappNumber = typeof (payload && payload.whatsappNumber) === 'string' ? payload.whatsappNumber : '';

  // Cheap per-IP hygiene against scripted abuse, same reasoning/shape as
  // save-push-subscription.js's identical guard — not a real security
  // boundary (see header comment above), just bounding pointless request
  // volume against this unauthenticated write.
  var maxPerDay = parseInt(process.env.MAX_SAVE_WHATSAPP_NUMBER_ATTEMPTS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_PER_IP_PER_DAY_DEFAULT;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'save-whatsapp-number-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E5: rate_limited' }) };
  }

  var result = await accountStore.setWhatsappNumber(event, username, whatsappNumber);
  if (!result.ok && result.error === 'invalid_number') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: invalid_number' }) };
  }
  if (!result.ok && result.error === 'not_found') {
    return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'E6: not_found' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, whatsappNumber: result.record.whatsappNumber || null }) };
};
