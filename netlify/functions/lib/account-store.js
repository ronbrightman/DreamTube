// netlify/functions/lib/account-store.js
//
// Real, server-side account store — the fix for "accounts only work on the
// device they were created on" (see tracker.html's now-resolved
// accounts-dont-sync-across-devices item). Before this file existed,
// js/store.js's whole account model (username/password/email) lived only in
// each browser's localStorage, with no server touchpoint at all — this is
// the small, scoped piece that moves just the account CHECK (does this
// username/email exist, does this password match it) server-side, so login
// and forgot-password work from any device. Not a Netlify Function itself —
// a plain module register-account.js/account-login.js/verify-password-
// reset.js all require(), matching this codebase's existing "self-contained
// function, shared bits in a plain require()" pattern (see entitlements.js,
// paywall-settings.js, tracker-store.js).
//
// Deliberately narrow scope — does NOT sync dreams/characters/videos. That
// stays exactly as it is today (state.dreams/charactersByUser, local-only,
// unkeyed by any server identity) — see tracker.html's
// sync-private-dreams-videos-later item for why that's a separate, bigger,
// deliberately deferred project, not something this file reaches for.
//
// Backed by a single Netlify Blobs store ("dreamtube-accounts"), with TWO
// kinds of keys sharing that one store (same "one small store, a couple of
// key prefixes" shape paywall-settings.js/tracker-store.js already use for
// their own single-purpose data, just with two prefixes instead of one
// here since a login needs to resolve BY EMAIL as well as by username):
//   "u:<normalized username>" -> { username, email, password, updatedAt }
//     — the actual account record, one per account.
//   "e:<normalized email>"    -> "<normalized username>"
//     — a secondary index so a login/reset by email can find the right
//       account record without scanning every key in the store (Blobs has
//       no query/scan API cheap enough to rely on here, same reasoning
//       js/store.js's own findAccountKeyByEmail sidesteps client-side by
//       just iterating its small local `accounts` object — that approach
//       doesn't scale to a real, shared, potentially-large server store).
//
// Username/email are both normalized (trim + lowercase) before ever being
// used as a key, exactly like every other identity check in this codebase:
// js/store.js's own accounts object is already keyed by lowercased
// username; normalizeEmail below is the exact same trim+lowercase helper
// entitlements.js/admin-paywall-toggle.js already use for email — reused
// here via require(), not reimplemented, per this codebase's own explicit
// "not a reimplementation" precedent (see admin-paywall-toggle.js's header
// comment on why it reuses entitlements.js's normalizeEmail instead of
// rolling its own).
//
// Two-key writes are NOT atomic — createAccount/applyPasswordReset each
// write the "u:" record and the "e:" index in two separate Blobs calls, and
// the installed @netlify/blobs SDK has no compare-and-swap/transaction
// primitive to make that one write (same underlying limitation already
// documented in entitlements.js and flagged repo-wide by the
// decide-blobs-lazy-seed-race tracker item). A request that fails/crashes
// between the two writes would leave a record with no matching email
// index (or vice versa) — accepted here deliberately, not fixed, for the
// same reason entitlements.js accepts its own narrow last-write-wins
// races: account registration/reset is low-frequency, single-record-at-a-
// time, and the worst case (a stale/missing index entry) is a failed
// lookup on the next request, not silent data corruption or a security
// hole. Revisit only if this store's write volume/criticality changes
// enough to justify a heavier fix.
//
// Passwords stay plaintext here, same already-accepted tradeoff
// js/store.js's own comment documents for the local copy (no real backend,
// no hashing infra, by design for now) — this is a lateral move (plaintext
// mirrored server-side, not a new/weaker exposure), not a regression, and
// not something this file's task is meant to change.

var { getStore, connectLambda } = require('@netlify/blobs');
var { normalizeEmail } = require('./entitlements');

var STORE_NAME = 'dreamtube-accounts';

/** Trims + lowercases a username so every caller keys/looks up consistently. Returns '' for anything falsy/non-string. Same shape as entitlements.js's normalizeEmail, just for the other identity this store keys by. */
function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function store() {
  return getStore({ name: STORE_NAME });
}

/**
 * Looks up an account record by username, or null if none exists yet.
 * `event` is the calling function's Lambda event, passed through to
 * connectLambda so this works from any Netlify Function.
 */
async function getByUsername(event, username) {
  var key = normalizeUsername(username);
  if (!key) return null;
  connectLambda(event);
  return (await store().get('u:' + key, { type: 'json' })) || null;
}

/**
 * Looks up an account record by email, via the "e:" secondary index, or
 * null if no account is registered under that email.
 */
async function getByEmail(event, email) {
  var normalized = normalizeEmail(email);
  if (!normalized) return null;
  connectLambda(event);
  var username = await store().get('e:' + normalized, { type: 'json' });
  if (!username) return null;
  return getByUsername(event, username);
}

/**
 * Registers a brand-new account. Rejects if EITHER the username or the
 * email is already registered server-side — this is the authoritative
 * uniqueness check now (see register-account.js), not js/store.js's local
 * per-browser one. Returns { ok:true, record } on success, or
 * { ok:false, error } — 'username_taken' or 'email_taken' — on a
 * collision. Callers are expected to have already validated shape
 * (length/format) before calling this; this function only checks
 * uniqueness and writes.
 */
async function createAccount(event, account) {
  var key = normalizeUsername(account.username);
  var email = normalizeEmail(account.email);
  connectLambda(event);
  var s = store();

  var existingByUsername = await s.get('u:' + key, { type: 'json' });
  if (existingByUsername) return { ok: false, error: 'username_taken' };

  var existingEmailOwner = await s.get('e:' + email, { type: 'json' });
  if (existingEmailOwner) return { ok: false, error: 'email_taken' };

  var record = { username: key, email: email, password: account.password, updatedAt: Date.now() };
  await s.setJSON('u:' + key, record);
  await s.setJSON('e:' + email, key);
  return { ok: true, record: record };
}

/**
 * Resolves `usernameOrEmail` (by username first, then by the email index)
 * and checks `password` against whatever account it finds. Returns
 * { ok:true, record } on a match, or { ok:false, error } where error is
 * 'not_found' (no account under that username or email at all) or
 * 'incorrect_password' (account found, password didn't match) — callers
 * use this distinction to decide whether a fallback to a legacy local-only
 * check is appropriate (not_found only — see js/store.js's login()), since
 * a wrong password against a REAL registered account should never be
 * silently second-guessed by a local fallback.
 */
async function verifyLogin(event, usernameOrEmail, password) {
  var key = normalizeUsername(usernameOrEmail);
  var record = await getByUsername(event, key);
  if (!record) record = await getByEmail(event, usernameOrEmail);
  if (!record) return { ok: false, error: 'not_found' };
  if (record.password !== password) return { ok: false, error: 'incorrect_password' };
  return { ok: true, record: record };
}

/**
 * Writes a new password for `username`, upserting the account record if
 * none exists there yet — the moment a verified, token-holding password
 * reset (see verify-password-reset.js) also backfills a pre-fix,
 * local-only account into this store for the first time, using the email
 * the reset was actually sent to (request-password-reset.js's own record).
 * Unlike createAccount, this never rejects on "already exists" — a
 * password reset legitimately overwrites whatever password was there
 * before, if any. Returns the updated/created record.
 */
async function applyPasswordReset(event, account) {
  var key = normalizeUsername(account.username);
  var email = normalizeEmail(account.email);
  connectLambda(event);
  var s = store();
  var existing = await s.get('u:' + key, { type: 'json' });
  var record = Object.assign({}, existing, {
    username: key,
    email: email,
    password: account.password,
    updatedAt: Date.now()
  });
  await s.setJSON('u:' + key, record);
  await s.setJSON('e:' + email, key);
  return record;
}

module.exports = {
  STORE_NAME,
  normalizeUsername,
  getByUsername,
  getByEmail,
  createAccount,
  verifyLogin,
  applyPasswordReset
};
