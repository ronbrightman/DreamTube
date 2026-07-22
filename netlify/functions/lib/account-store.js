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
// "No retroactive lockout" is a goal here, not an absolute guarantee — one
// known, inherent edge case: if the SAME username was independently created
// as two different local-only accounts on two different devices before
// this store existed, whichever one backfills here first (see
// js/store.js's backfillAccountServerSide, and that function's own doc
// comment for the full writeup) permanently wins that username server-side.
// The other device's account isn't retroactively broken ON THAT DEVICE
// (its own localStorage still logs it in there, unchanged) — but the
// moment it's used from anywhere account-login.js has to actually check
// (a fresh device, cleared storage, etc.), it gets a genuine, server-
// confirmed incorrect_password rejection with no local fallback, since
// there's no way for this store to know two different browsers ever
// independently claimed the same name. This is an unavoidable consequence
// of retrofitting real uniqueness onto a system that previously had none,
// not a bug this file is meant to fix.
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
// the installed @netlify/blobs SDK exposes no compare-and-swap/transaction
// primitive (checked node_modules/@netlify/blobs/dist/main.d.ts directly —
// set()/setJSON() take no etag/onlyIf condition at all) to make that one
// write atomic.
//
// Unlike the lazy-seed race entitlements.js/paywall-settings.js/
// tracker-store.js accept (a one-time-per-key materialization that's rare
// and whose worst case is a dropped increment), this store is written on
// EVERY signup/reset, and a lost race here can misdirect or lock a real
// person out of their own account (see the two concrete scenarios below) —
// that reasoning doesn't transfer, so this is narrowed instead of just
// documented:
//   - Two concurrent signups for the SAME username, different emails: with
//     a plain last-write-wins two-key write, the losing signer's OWN client
//     already got ok:true and cached that password locally — their next
//     login is a genuine incorrect_password rejection from the server, with
//     no local fallback (by design — see verifyLogin's own comment on why a
//     wrong password against a real registered account is never
//     second-guessed locally). That's a real account lockout, not a cosmetic
//     glitch.
//   - Because the "e:" index write and the "u:" record's own `email` field
//     could be won by DIFFERENT concurrent requests, getByEmail() could
//     resolve a username whose CURRENT "u:" record has a different email
//     than the one actually queried — a password-reset lookup by email
//     could then email a reset link to the wrong current owner of that
//     username.
//
// The fix below doesn't add real atomicity (there is no primitive here to
// build that on) — it narrows the window by having each write immediately
// read itself back and comparing what's actually there against what this
// call itself just wrote, on BOTH keys. A concurrent writer that raced in
// between the write and the read-back changes what the read-back sees, so
// the loser can detect that and fail cleanly with a distinct 'conflict'
// error (see register-account.js's E10/verify-password-reset.js's E6) that
// the client surfaces as "try again" — instead of returning ok:true over
// data that a moment later belonged to someone else. This still has an
// inherent gap (a third write landing between this call's own write and its
// own read-back would go undetected), but that's a much narrower window
// than "the entire two-key write with no check at all", and two clients
// racing on the exact same username/email — the actual scenario this
// exists for — reliably narrows to one clean success and one clean,
// safe-to-retry conflict rather than silent corruption. See
// test/account-store.test.js's concurrency test for exactly this scenario.
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
 * { ok:false, error } — 'username_taken' / 'email_taken' on a pre-existing
 * collision, or 'conflict' when a concurrent write raced this one and won
 * (see the header comment's narrowed-race writeup) — callers should treat
 * 'conflict' as safe to retry, never as evidence the account wasn't
 * created (it wasn't, by this call).
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

  // Claim the email index FIRST, then read it straight back — see the
  // header comment. If a concurrent createAccount/applyPasswordReset for a
  // DIFFERENT username won this same email key in between, this read-back
  // sees THEIR username, not ours, and we bail out here having written
  // nothing to 'u:' at all.
  await s.setJSON('e:' + email, key);
  var emailIndexAfterClaim = await s.get('e:' + email, { type: 'json' });
  if (emailIndexAfterClaim !== key) return { ok: false, error: 'conflict' };

  var record = { username: key, email: email, password: account.password, updatedAt: Date.now() };
  await s.setJSON('u:' + key, record);
  // Same idea for the username record itself: read our own write straight
  // back. A concurrent createAccount for the SAME username that wrote
  // after us flips what's actually stored here to THEIR email/password —
  // if that happened, we lost the race and must not report ok:true over
  // data that isn't ours anymore.
  var afterWrite = await s.get('u:' + key, { type: 'json' });
  if (!afterWrite || afterWrite.email !== email || afterWrite.password !== account.password) {
    return { ok: false, error: 'conflict' };
  }

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
 * before, if any. Returns { ok:true, record } on success, or
 * { ok:false, error:'conflict' } when a concurrent write raced this one and
 * won (same narrowed-race check as createAccount, see the header comment
 * and that function's own comment) — callers should treat this as
 * safe-to-retry, not as evidence the reset failed to apply anywhere.
 */
async function applyPasswordReset(event, account) {
  var key = normalizeUsername(account.username);
  var email = normalizeEmail(account.email);
  connectLambda(event);
  var s = store();

  await s.setJSON('e:' + email, key);
  var emailIndexAfterClaim = await s.get('e:' + email, { type: 'json' });
  if (emailIndexAfterClaim !== key) return { ok: false, error: 'conflict' };

  var existing = await s.get('u:' + key, { type: 'json' });
  var record = Object.assign({}, existing, {
    username: key,
    email: email,
    password: account.password,
    updatedAt: Date.now()
  });
  await s.setJSON('u:' + key, record);
  var afterWrite = await s.get('u:' + key, { type: 'json' });
  if (!afterWrite || afterWrite.email !== email || afterWrite.password !== account.password) {
    return { ok: false, error: 'conflict' };
  }

  return { ok: true, record: record };
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
