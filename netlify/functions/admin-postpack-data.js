// netlify/functions/admin-postpack-data.js
//
// Owner-only, real-password-gated data feed for postpack-h4mv.html —
// tracker item for-product-instagram-tiktok-auto-postin-cahr76, Manager's
// SPEC v1. Reads every pack item assemble-instagram-tiktok-postpack.js has
// ever built (lib/postpack-store.js's full history), newest-first, so the
// founder can browse/download/copy-and-post each one at his own pace —
// same "owner tool reads the real durable store directly" shape as
// admin-media-library-data.js.
//
// PRIVACY/SCOPE: pack items are built ONLY from dreams that were already
// published to the public shared feed (get-feed.js) with real, on-file
// channel-license consent (see lib/postpack-selector.js's own eligibility
// rules) — nothing here is private-dream content a user didn't already
// choose to publish. Still gated behind the same real-password +
// OWNER_EMAIL bar as every sibling admin diagnostic (see
// admin-media-library-data.js's own header comment) rather than left open
// like get-feed.js itself, since this endpoint additionally exposes which
// specific published dreams have already been claimed for outbound social
// promotion — internal operational detail, not something worth leaving
// world-readable just because the underlying dream is public.
//
// Error codes (same small-number scheme as admin-media-library-data.js):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited

var accountStore = require('./lib/account-store');
var postpackStore = require('./lib/postpack-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

/** Real, server-verified credential check + owner-email confirmation — same shape as admin-media-library-data.js's own verifyOwnerCredentials. */
async function verifyOwnerCredentials(event, usernameOrEmail, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };

  var loginCheck = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };

  if (normalizeEmail(loginCheck.record.email) !== ownerEmail) {
    return { ok: false, error: 'not_owner' };
  }
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
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  var usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
  var password = typeof payload.password === 'string' ? payload.password : '';
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_POSTPACK_DATA_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 200;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_POSTPACK_DATA_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 200;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-postpack-data-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-postpack-data-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  try {
    var items = await postpackStore.getItems(event);
    var sorted = items.slice().sort(function (a, b) { return (b.builtAt || 0) - (a.builtAt || 0); });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, generatedAt: Date.now(), items: sorted })
    };
  } catch (e) {
    console.error('admin-postpack-data: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'fetch_failed: ' + (e && e.message) }) };
  }
};
