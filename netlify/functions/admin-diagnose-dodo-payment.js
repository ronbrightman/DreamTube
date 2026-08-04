// netlify/functions/admin-diagnose-dodo-payment.js
//
// READ-ONLY diagnostic for tracker item
// for-product-dodo-evidence-in-founder-08--04z6ln: the founder pasted a
// real Dodo webhook payload showing `payment.succeeded` fired Dodo-side
// (payment_id pay_0NkXXcjgKWjX3MLhfP5xP, settlement $1.99, metadata intact
// -- dreamtube_pack=pack199, dreamtube_tokens=500, dreamtube_email=<founder>)
// but the founder never received his 500 tokens. Conclusion: Dodo's
// checkout wiring is fine -- the miss is in OUR webhook delivery/
// processing. The founder's own ordered diagnostic checklist, step 1:
// "does the credit-once marker / token ledger show ANY processing for
// this payment_id? If none, the request never passed our door."
//
// That is exactly what this tool answers, and ONLY that -- a direct read
// of lib/entitlements.js's TOKEN_PURCHASES_STORE_NAME ("dreamtube-token-
// purchases") Blobs store, one record per Dodo payment_id, shape
// { email, tokens, status: 'pending'|'committed', claimId, createdAt }
// (see creditTokenPackOnce's own doc block for the full two-phase-marker
// mechanism). A `null` read means no marker exists at all for that
// payment_id -- i.e. dodo-webhook.js's handler never even started
// processing it, which is direct evidence the request never reached our
// door (as opposed to reaching it and failing partway, which would leave
// a 'pending' marker behind).
//
// Steps 2-3 of the founder's checklist -- whether the webhook URL
// registered in Dodo's own dashboard matches our actual function path,
// and whether Saturday's DODO_WEBHOOK_SECRET rotation broke signature
// verification -- need Dodo dashboard access this sandbox doesn't have.
// Out of scope for this tool; those stay a human/Manager follow-up once
// this tool's answer is in hand.
//
// AUTH: identical bar to every sibling admin diagnostic in this codebase
// -- real, server-verified password (lib/account-store.js's verifyLogin)
// against an account whose own on-file email matches OWNER_EMAIL.
// Duplicated inline rather than shared, matching this codebase's explicit
// precedent (see admin-diagnose-account-duplicates.js / admin-diagnose-
// rename-conflict.js's own header comments on why).
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool.
//
// SCOPE -- READ ONLY: this tool never calls addTokens, creditTokenPackOnce,
// or any other mutating entitlements function, and never calls Dodo's own
// API. It only ever reads the existing marker. Crediting a real founder-
// reported miss (or fixing the secret/URL) is a separate, deliberate,
// human/Manager-driven action once this tool's read confirms the actual
// failure point -- never something this file does itself.
//
// PRIVACY: the marker this reads was written by our OWN webhook handler,
// not user-supplied -- there's no PII-beyond-email/tokens concern reading
// it back (no password/payment-instrument data of any kind lives in this
// store).
//
// Request: POST { usernameOrEmail, password, paymentIds: [string, ...] }
//   paymentIds: 1-20 arbitrary Dodo payment_id strings to check (same
//   bounds as admin-diagnose-account-duplicates.js's `usernames` array --
//   rejects an empty or oversized list rather than silently truncating or
//   no-op'ing).
// Response: 200 { ok:true, ownerEmail, results: [ {
//   paymentId, markerExists, status, email, tokens, createdAt
// }, ... ] }
//   markerExists: false means dodo-webhook.js's handler never started
//     processing this payment_id at all -- the request never reached our
//     door (founder checklist step 1's direct answer).
//   status/email/tokens/createdAt: the marker's own fields when
//     markerExists is true ('pending' means processing started but never
//     reached 'committed' -- see creditTokenPackOnce's doc block for what
//     that implies); all null when markerExists is false.
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 invalid_payment_ids — `paymentIds` missing, not an array, empty,
//      over 20 entries, or containing a non-string/blank entry

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_PAYMENT_IDS = 20;
var TOKEN_PURCHASES_STORE_NAME = 'dreamtube-token-purchases';

function tokenPurchasesStore() {
  return getStore({ name: TOKEN_PURCHASES_STORE_NAME });
}

/** Real, server-verified credential check + owner-email confirmation -- duplicated from the sibling admin diagnostics' own copy, see header comment. */
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

async function diagnoseOne(event, paymentId) {
  connectLambda(event);
  var marker = await tokenPurchasesStore().get(paymentId, { type: 'json' });
  if (!marker) {
    return { paymentId: paymentId, markerExists: false, status: null, email: null, tokens: null, createdAt: null };
  }
  return {
    paymentId: paymentId,
    markerExists: true,
    status: marker.status || null,
    email: marker.email || null,
    tokens: typeof marker.tokens === 'number' ? marker.tokens : null,
    createdAt: marker.createdAt || null
  };
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

  var paymentIds = payload.paymentIds;
  var paymentIdsValid = Array.isArray(paymentIds) && paymentIds.length > 0 && paymentIds.length <= MAX_PAYMENT_IDS &&
    paymentIds.every(function (p) { return typeof p === 'string' && p.trim(); });
  if (!paymentIdsValid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: invalid_payment_ids' }) };
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_DODO_PAYMENT_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dodo-payment-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-dodo-payment-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var results = [];
  for (var i = 0; i < paymentIds.length; i++) {
    results.push(await diagnoseOne(event, paymentIds[i]));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ownerEmail: ownerEmail, results: results })
  };
};
