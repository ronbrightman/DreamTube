// netlify/functions/admin-diagnose-account-duplicates.js
//
// READ-ONLY diagnostic for tracker item
// for-product-urgent-email-dedup-integrity-iys5fb: the first-dream
// retention email fired 2-4 times for several accounts even though
// lib/first-dream-email-store.js's markSentOnce is a genuine blobs10
// compare-and-swap, keyed purely by username, correctly once-ever-per-
// account. That refutes a CAS-integrity bug -- the leading hypothesis
// instead is DUPLICATE ACCOUNTS sharing one real email: this is an
// already-CONFIRMED bug class in this exact codebase (tracker item
// for-product-bug-founder-account-u-ronbri-0gwe1m -- ronbrightman's own
// account existed under two different usernames sharing one email,
// discovered by admin-diagnose-rename-conflict.js). If N different
// usernames share one inbox, each is a fully legitimate account, each
// correctly wins its own CAS claim and sends exactly once -- markSentOnce
// isn't broken, there are just N accounts pointed at that inbox.
//
// This generalizes admin-diagnose-rename-conflict.js's own check (which
// only ever compares two HARDCODED usernames) to an arbitrary caller-
// supplied list, so it can be pointed at whichever specific usernames a
// future investigation names (today: the 2-4x accounts from iys5fb) without
// writing a new one-off file per incident.
//
// WHAT IT DETECTS, PER REQUESTED USERNAME:
//   - Whether the username exists at all, and its own on-file email.
//   - What lib/account-store.js's "e:<email>" secondary index CURRENTLY
//     resolves to for that email. If it resolves to a DIFFERENT username
//     than the one being checked, that is direct proof at least one OTHER
//     account shares this exact email (the index is a single key -- see
//     account-store.js's own header comment -- so it can only ever point
//     at ONE of them; a mismatch here means the requested username's own
//     record exists but lost that index to a different account).
// This does NOT enumerate every duplicate exhaustively (there is no
// "list every account by email" primitive in this store, same limitation
// admin-diagnose-rename-conflict.js's own header comment already documents
// for its own narrower two-username check) -- it proves duplication when
// present for the SPECIFIC usernames asked about, which is exactly what an
// incident investigation naming specific affected accounts needs.
//
// AUTH: identical bar to every sibling admin diagnostic in this codebase --
// real, server-verified password (lib/account-store.js's verifyLogin)
// against an account whose own on-file email matches OWNER_EMAIL.
// Duplicated inline rather than shared, matching this codebase's explicit
// precedent (see admin-diagnose-rename-conflict.js's own header comment).
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool.
//
// PRIVACY: this can read OTHER real users' account metadata (email,
// updatedAt) -- same class of exposure admin-diagnose-rename-conflict.js's
// own header comment already accepts for its narrower two-username case,
// gated the same way (founder-only real-password auth). It reports ONLY
// the fields needed to prove/disprove duplication (username, email,
// updatedAt, renamedFrom) -- no dream content, no token balance, no
// password data of any kind.
//
// Request: POST { usernameOrEmail, password, usernames: [string, ...] }
//   usernames: 1-20 arbitrary username strings to check (rejects an empty
//   or oversized list rather than silently truncating or no-op'ing).
// Response: 200 { ok:true, ownerEmail, results: [ {
//   requestedUsername, exists, email, updatedAt, renamedFrom,
//   emailIndexTarget, likelyDuplicate
// }, ... ] }
//   emailIndexTarget: the username the "e:<email>" index currently
//     resolves to for THIS account's own email (null if the account
//     doesn't exist, or has no email on file).
//   likelyDuplicate: true when the account exists, has an email, AND
//     emailIndexTarget is a DIFFERENT username -- the direct evidence
//     described above.
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 invalid_usernames — `usernames` missing, not an array, empty, over
//      20 entries, or containing a non-string/blank entry

var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var MAX_USERNAMES = 20;

/** Real, server-verified credential check + owner-email confirmation -- duplicated from admin-diagnose-rename-conflict.js's own copy, see header comment. */
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

async function diagnoseOne(event, requestedUsername) {
  var record = await accountStore.getByUsername(event, requestedUsername);
  if (!record) {
    return { requestedUsername: requestedUsername, exists: false, email: null, updatedAt: null, renamedFrom: null, emailIndexTarget: null, likelyDuplicate: false };
  }

  var email = normalizeEmail(record.email);
  var emailIndexTarget = null;
  if (email) {
    var resolved = await accountStore.getByEmail(event, email);
    emailIndexTarget = resolved ? resolved.username : null;
  }

  var normalizedRequested = accountStore.normalizeUsername(requestedUsername);
  var likelyDuplicate = !!(email && emailIndexTarget && emailIndexTarget !== normalizedRequested);

  return {
    requestedUsername: requestedUsername,
    exists: true,
    email: record.email,
    updatedAt: record.updatedAt || null,
    renamedFrom: record.renamedFrom || null,
    emailIndexTarget: emailIndexTarget,
    likelyDuplicate: likelyDuplicate
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

  var usernames = payload.usernames;
  var usernamesValid = Array.isArray(usernames) && usernames.length > 0 && usernames.length <= MAX_USERNAMES &&
    usernames.every(function (u) { return typeof u === 'string' && u.trim(); });
  if (!usernamesValid) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: invalid_usernames' }) };
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_ACCOUNT_DUPLICATES_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_ACCOUNT_DUPLICATES_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-account-duplicates-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-account-duplicates-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var results = [];
  for (var i = 0; i < usernames.length; i++) {
    results.push(await diagnoseOne(event, usernames[i]));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, ownerEmail: ownerEmail, results: results })
  };
};
