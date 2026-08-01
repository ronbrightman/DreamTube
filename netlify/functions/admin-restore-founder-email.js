// netlify/functions/admin-restore-founder-email.js
//
// ONE-OFF, HARDCODED data-correction endpoint for tracker item
// for-product-bug-founder-account-u-ronbri-0gwe1m: the founder's own
// account, u:ronbrightman, was reported to have no email attached
// (Settings' account sheet shows it blank), which breaks password reset,
// retention emails, and every other email-keyed flow for that specific
// account.
//
// INVESTIGATION SUMMARY (see this task's own writeup for the full
// systematic-debugging trail) — the tracker item's own theory was that
// admin-consolidate-accounts.js (the one-off tool that merged
// u:__probe_throwaway_user__ into u:ronbrightman on 2026-07-30, since
// deleted per this repo's "remove one-off admin panels after use" policy
// — recoverable at git commit bec452c) silently dropped the email field
// during that merge. Reading that recovered code line by line REFUTES
// this theory: its performConsolidation() explicitly constructs the
// surviving record as
//   Object.assign({}, ronRecord, { email: ownerEmail, password: ...,
//     updatedAt: ..., consolidatedFrom: ..., consolidatedAt: ...,
//     previousEmail: ronRecord.email })
// i.e. it spreads the EXISTING record first and only overrides specific
// fields, so email is both explicitly set (never dropped) and every other
// pre-existing field (fbUserId, createdAt, etc.) survives via the spread.
// This exact behavior already had dedicated test coverage at the time
// (test/admin-consolidate-accounts.test.js, git history) which passed.
// admin-rename-account.js (the older sibling, also deleted, recoverable
// at 6bf00cb) uses the identical spread-first pattern and was checked too
// — same conclusion, no field-dropping bug in either recovered tool.
//
// So the most likely explanation for "Settings shows it empty" is NOT a
// server-side data-loss bug in either historical merge tool, but a
// CLIENT-SIDE staleness gap: profile.html's account sheet reads
// DreamStore.getAccountEmail(), which is a purely local, browser-cached
// value (js/store.js's state.accounts[key].email) that is only ever
// refreshed by a full server round-trip through login(). A founder
// browser with a long-persisted session (never re-entering credentials
// since before email was retrofitted onto this account, or since the
// last-format-upgrade that stamps `email: null` onto old plain-string
// account entries — see js/store.js's own comment at the "Accounts used
// to be `{ key: password }`" migration) would show blank in Settings
// regardless of what the server-side record actually has on file. This
// sandbox has no production Blobs credentials, so it cannot confirm which
// of "server record is genuinely empty" vs. "server is fine, client cache
// is stale" is actually true right now — that requires a live check
// (e.g. an authenticated GET below, or simply a fresh, real login from
// the founder's own device, which alone might already fix Settings'
// display with zero server write needed).
//
// This endpoint exists to close the loop EITHER WAY, safely:
//   - GET (owner-authenticated the same way as the POST — see below)
//     reports u:ronbrightman's CURRENT on-file email with no mutation at
//     all, so the coordinating session can confirm which hypothesis is
//     true before deciding whether the POST is even needed.
//   - POST performs the actual restore, but ONLY if the current on-file
//     email genuinely isn't already correct (idempotent no-op otherwise)
//     — never a blind overwrite.
//
// NOT a general "set any account's email" tool — RESTORE_USERNAME below
// is a hardcoded constant, not a request parameter, same one-off-tool
// reasoning admin-rename-account.js's/admin-consolidate-accounts.js's own
// header comments already establish. Per those same tracker items' and
// this task's own instruction: DELETE THIS FILE (and its test) once used,
// matching how admin-consolidate-accounts.js itself was cleaned up
// (commit e30e26b).
//
// AUTH: real, server-verified password (lib/account-store.js's
// verifyLogin) against the literal hardcoded account this tool repairs —
// the SAME "real password, not a client-trusted claim" bar admin-rename-
// account.js/admin-consolidate-accounts.js already set for any endpoint
// that mutates a real account record, not owner-topup-tokens.js's/
// admin-paywall-toggle.js's lighter "trust the client-supplied email"
// pattern (those two only ever flip a flag or credit the OWNER'S OWN
// balance — trivially reversible, already scoped to an account the caller
// controls either way; this endpoint overwrites a real account's email
// field, the same consequential class of action admin-rename-account.js's
// own header comment reasons through at length).
//
// One deliberate difference from those two siblings' own auth checks,
// worth calling out explicitly: admin-rename-account.js/admin-consolidate-
// accounts.js could ADDITIONALLY cross-check the authenticating account's
// own on-file email against OWNER_EMAIL, because at the time they ran a
// SEPARATE, already-correct account (the probe account) existed to
// authenticate through. This tool has no such second account — its entire
// job is repairing RESTORE_USERNAME's own broken email field, so requiring
// that email to already be correct as a precondition for using it would
// make it unusable exactly when it's needed (a real chicken-and-egg
// mistake this file's first draft made and caught before shipping). The
// real, sufficient authorization boundary here is instead: the caller must
// know RESTORE_USERNAME's actual current password, a real server-verified
// check against the one literal hardcoded account this tool touches —
// pass the username "ronbrightman" itself (not its possibly-broken email)
// as `usernameOrEmail` to sidestep the email index entirely.
//
// Duplicated inline (not required from a shared module) matching this
// codebase's own explicit precedent for small, self-contained one-off
// admin functions (see lib/job-owners.js's header comment, and every
// sibling admin-*.js file's identical copy).
//
// Request:
//   GET  ?usernameOrEmail=...&password=... -> read-only report, no writes.
//   POST { usernameOrEmail, password } -> performs the restore if needed.
//     No dryRun flag (unlike the historical merge tools) — GET already IS
//     the dry-run/preview here, so POST always means "really do it,"
//     matching this file's narrower single-purpose scope.
//
// Response: 200 { ok:true, status, account: { username, email },
//   previousEmail }
//   status one of:
//     'already_correct' — email was already exactly OWNER_EMAIL; no write.
//     'restored'         — email was empty/blank/anything else; corrected.
//
// Note there is no separate "account doesn't exist" refusal code: since
// auth (above) requires a real password match against RESTORE_USERNAME
// itself, a nonexistent u:ronbrightman can never pass auth in the first
// place — that case is indistinguishable from, and reported the same as,
// any other credential failure (E5, below), by design (same "don't help
// an attacker enumerate accounts" reasoning verify-owner-bypass.js's own
// single E5 already uses).
//
// Error codes (local to this function, same small-number-scheme reasoning
// as every sibling admin-*.js file in this codebase):
//   E1 method_not_allowed — verb other than GET/POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json (POST only)
//   E4 missing_fields — usernameOrEmail/password not both present
//   E5 forbidden — covers every credential-check failure, including
//       RESTORE_USERNAME not existing at all yet (see note above)
//   E6 rate_limited — too many attempts (per-IP or per-identifier) today

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var RESTORE_USERNAME = accountStore.normalizeUsername('ronbrightman');

function accountsStore() {
  return getStore({ name: accountStore.STORE_NAME });
}

/**
 * Real, server-verified credential check -- but against RESTORE_USERNAME
 * itself (never an email-match cross-check) -- see header comment's AUTH
 * section for exactly why that's the correct, non-circular bar for this
 * specific one-off tool.
 */
async function verifyOwnerCredentials(event, usernameOrEmail, password) {
  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) return { ok: false, error: 'owner_not_configured' };

  var loginCheck = await accountStore.verifyLogin(event, usernameOrEmail, password);
  if (!loginCheck.ok) return { ok: false, error: loginCheck.error };

  if (accountStore.normalizeUsername(loginCheck.record.username) !== RESTORE_USERNAME) {
    return { ok: false, error: 'not_owner' };
  }
  return { ok: true, record: loginCheck.record };
}

/**
 * The actual read (and, if `write`, restore) of u:ronbrightman's email.
 * Returns { httpStatus, body }. Never touches any field other than
 * `email`/`updatedAt`/`previousEmail`/`restoredAt` -- every other
 * pre-existing field on the record (password, fbUserId, createdAt, any
 * prior consolidatedFrom/renamedFrom marker, etc.) survives untouched via
 * the Object.assign spread below, the same field-preserving pattern this
 * file's header comment confirmed the historical merge tools already used
 * correctly. `record` is always non-null here -- auth (see header comment)
 * already required a real password match against this exact account, so
 * getByUsername finding nothing at this point would mean the account was
 * deleted in the narrow window between auth and this call; not handled as
 * a distinct case, since that's already an accepted, vanishingly-unlikely
 * race every other one-off admin tool in this codebase carries.
 */
async function reportOrRestore(event, ownerEmail, write) {
  connectLambda(event);
  var s = accountsStore();

  var record = await accountStore.getByUsername(event, RESTORE_USERNAME);
  var currentEmail = normalizeEmail(record.email);
  if (currentEmail === ownerEmail) {
    return {
      httpStatus: 200,
      body: {
        ok: true, status: 'already_correct',
        account: { username: record.username, email: record.email },
        previousEmail: record.email
      }
    };
  }

  if (!write) {
    // GET path: report what a restore WOULD do, without writing.
    return {
      httpStatus: 200,
      body: {
        ok: true, status: 'would_restore',
        account: { username: record.username, email: record.email },
        previousEmail: record.email
      }
    };
  }

  var previousEmail = record.email;
  var updated = Object.assign({}, record, {
    email: ownerEmail,
    updatedAt: Date.now(),
    previousEmail: previousEmail,
    restoredAt: Date.now(),
    restoredBy: 'admin-restore-founder-email'
  });
  await s.setJSON('u:' + RESTORE_USERNAME, updated);
  // Keep the "e:" index consistent with the record it should now resolve
  // to -- defense in depth, same shape admin-consolidate-accounts.js's own
  // performConsolidation used for its equivalent write.
  await s.setJSON('e:' + ownerEmail, RESTORE_USERNAME);

  return {
    httpStatus: 200,
    body: {
      ok: true, status: 'restored',
      account: { username: updated.username, email: updated.email },
      previousEmail: previousEmail
    }
  };
}

exports.handler = async function (event) {
  var method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var usernameOrEmail, password;
  if (method === 'GET') {
    var q = event.queryStringParameters || {};
    usernameOrEmail = typeof q.usernameOrEmail === 'string' ? q.usernameOrEmail.trim() : '';
    password = typeof q.password === 'string' ? q.password : '';
  } else {
    var payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
    }
    usernameOrEmail = typeof payload.usernameOrEmail === 'string' ? payload.usernameOrEmail.trim() : '';
    password = typeof payload.password === 'string' ? payload.password : '';
  }

  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  // Same two-bucket (per-IP + per-identifier) rate limiting as every
  // sibling admin-*.js account tool, for the identical reason: this
  // performs a real password check against one specific, high-value
  // account.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_RESTORE_FOUNDER_EMAIL_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_RESTORE_FOUNDER_EMAIL_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-restore-founder-email-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-restore-founder-email-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var result = await reportOrRestore(event, ownerEmail, method === 'POST');
  return { statusCode: result.httpStatus, body: JSON.stringify(result.body) };
};
