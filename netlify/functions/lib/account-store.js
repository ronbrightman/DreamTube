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
// INCIDENT (2026-07-22): an earlier version of this file tried to narrow
// that race by having each write immediately read itself back and
// comparing what's actually there against what the call just wrote,
// treating any mismatch as a concurrent writer having won and failing
// cleanly with 'conflict'. That logic was validated across four review
// rounds entirely against test/helpers/mock-blobs.js's in-memory Map mock,
// which has perfect, synchronous read-after-write consistency by
// construction — so every test passed. The REAL @netlify/blobs store does
// not make that guarantee: a get() issued immediately after a setJSON() to
// the same key is not guaranteed to see that write yet, with no concurrent
// writer involved at all. In production this meant the "read our own write
// back" check failed essentially every time, on completely solo,
// non-colliding signups — a total outage of createAccount/
// applyPasswordReset (register-account.js's "Something went wrong creating
// your account" / verify-password-reset.js's equivalent), caught only once
// live because nothing in this repo's test suite exercises the real Blobs
// backend's actual consistency behavior (see dreamtube-signals for the
// write-up). Fixed by removing the immediate-read-back check entirely and
// reverting to a plain existence-check-then-write, same shape as every
// other Blobs-backed store in this codebase (entitlements.js,
// paywall-settings.js, tracker-store.js) — see those files' own comments
// for the same accepted-race reasoning, which applies here too now that
// nothing pretends to detect (unreliably) what it can't actually detect.
//
// What this means concretely: two concurrent signups for the SAME
// username, different emails, can still race (last write wins on both
// keys, not necessarily the same writer winning both) — this was true
// before the incident's ill-fated hardening attempt too, is the same
// tradeoff every other store here already accepts, and is judged low
// enough real-world likelihood (given actual signup volume) not to justify
// another attempt at detection this SDK has no reliable primitive for.
// getByEmail()'s own defense-in-depth check (below) still protects against
// the one concrete bad outcome (a password-reset misdirected to the wrong
// current owner of a username) independent of this.
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
  var record = await getByUsername(event, username);
  // Defense in depth (see the header comment's stale-index writeup, and
  // review finding ay3nqfz): the "e:" index and the "u:" record it points
  // at are two separate writes with no atomicity between them, so a lost
  // 'u:' race elsewhere can (should Fix A below ever miss a case) leave an
  // "e:" entry pointing at a record whose CURRENT email is no longer the
  // one just queried. Never hand back a record whose own `email` field
  // doesn't match what was actually asked for -- treat that mismatch as
  // "not found", exactly like no index entry existed at all. This
  // protects every caller of getByEmail (request-password-reset.js today)
  // even if createAccount/applyPasswordReset's own rollback below has any
  // remaining edge case.
  if (!record || record.email !== normalized) return null;
  return record;
}

/**
 * Registers a brand-new account. Rejects if EITHER the username or the
 * email is already registered server-side — this is the authoritative
 * uniqueness check now (see register-account.js), not js/store.js's local
 * per-browser one. Returns { ok:true, record } on success, or
 * { ok:false, error } — 'username_taken' / 'email_taken' on a pre-existing
 * collision. Plain existence-check-then-write, same accepted-race shape as
 * every other Blobs-backed store in this codebase — see the header
 * comment's INCIDENT note for why an earlier, stricter-looking version of
 * this function was actually broken in production and got reverted to
 * this simpler form.
 */
async function createAccount(event, account) {
  var key = normalizeUsername(account.username);
  var email = normalizeEmail(account.email);
  connectLambda(event);
  var s = store();

  var existingByUsername = await s.get('u:' + key, { type: 'json' });
  if (existingByUsername) return { ok: false, error: 'username_taken' };

  // Was a raw `s.get('e:'+email)` truthy-check until the incident below —
  // that only confirmed an "e:" index entry EXISTS, not that it still
  // points at a real, matching account. Because the "e:" index and "u:"
  // record are two separate non-atomic writes (see header comment), a
  // write that landed the index but not the record (a mid-write failure,
  // or an earlier bug) leaves a stale "e:" entry with no real owner —
  // getByEmail() already treats that as "not found" (its own defense-in-
  // depth check below), but this raw check didn't, so a real user's
  // signup AND login both permanently failed for that email: signup saw
  // "email_taken" from the orphaned index, login saw "not_found" because
  // getByEmail correctly refused to hand back a non-matching/missing
  // record. Reusing getByEmail's already-validated lookup here closes
  // that gap the same way, and — since createAccount's own write below
  // unconditionally overwrites whatever "e:" entry is there — a retried
  // signup for a genuinely-orphaned email now self-heals the stale index
  // instead of being permanently stuck behind it.
  var existingEmailOwner = await getByEmail(event, account.email);
  if (existingEmailOwner) return { ok: false, error: 'email_taken' };

  await s.setJSON('e:' + email, key);
  var record = { username: key, email: email, password: account.password, updatedAt: Date.now() };
  await s.setJSON('u:' + key, record);

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
 *
 * Optional 4th arg `preResolved` — pass `{ record }` (the account record,
 * or `null` if none was found) when the caller already did this exact
 * username-then-email lookup itself for an unrelated reason (see
 * account-login.js, which resolves the canonical account first for
 * rate-limit bucketing) so this function reuses that result instead of
 * doing the identical two Blobs reads a second time moments later. Must be
 * an object with an own `record` key to take effect — pass nothing (the
 * common case, every other caller in this codebase) to keep doing the
 * lookup here as always.
 */
async function verifyLogin(event, usernameOrEmail, password, preResolved) {
  var record;
  if (preResolved && Object.prototype.hasOwnProperty.call(preResolved, 'record')) {
    record = preResolved.record;
  } else {
    var key = normalizeUsername(usernameOrEmail);
    record = await getByUsername(event, key);
    if (!record) record = await getByEmail(event, usernameOrEmail);
  }
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
 * before, if any. Returns { ok:true, record }. Plain write, same accepted-
 * race shape as createAccount above — see the header comment's INCIDENT
 * note for why an earlier, stricter-looking version of this function was
 * actually broken in production and got reverted to this simpler form.
 */
async function applyPasswordReset(event, account) {
  var key = normalizeUsername(account.username);
  var email = normalizeEmail(account.email);
  connectLambda(event);
  var s = store();

  await s.setJSON('e:' + email, key);

  var existing = await s.get('u:' + key, { type: 'json' });
  var record = Object.assign({}, existing, {
    username: key,
    email: email,
    password: account.password,
    updatedAt: Date.now()
  });
  await s.setJSON('u:' + key, record);

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
