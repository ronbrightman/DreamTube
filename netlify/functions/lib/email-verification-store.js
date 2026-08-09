// netlify/functions/lib/email-verification-store.js
//
// Blobs-backed store for the DEFERRED email-verification mechanism
// (tracker item for-product-build-passwordless-signup-fo-at2fko,
// founder-decided passwordless-signup hybrid): a 6-digit code AND a
// "click this link" token, both minted together at signup time and kept
// alive until the account actually gets verified (by whichever of the two
// happens first) or the record expires.
//
// Deliberately mirrors request-password-reset.js's own Blobs-token shape
// (random value, TTL, non-atomic write, plain existence-check-then-write)
// rather than inventing a new pattern — see account-store.js's own header
// comment for why every store in this codebase already accepts that same
// tradeoff. UNLIKE a password-reset token, which is single-purpose and
// consumed the moment it's used, this record serves TWO different
// verification paths (a typed code, and a clicked link) that must both stay
// valid against the SAME underlying record until either one succeeds — so
// this keeps ONE record per account (keyed by username), not one per
// token, with a secondary "t:" index so the link path can resolve a bare
// token back to a username without an account-identity round trip first
// (the whole point of the implicit-verification link is that it works with
// NO signed-in session on the clicking device — see verify-email-link.js).
//
// Backed by a single Netlify Blobs store ("dreamtube-email-verifications"),
// with TWO kinds of keys sharing that store (same "one store, a couple of
// key prefixes" shape account-store.js/paywall-settings.js already use):
//   "u:<normalized username>" -> { email, codeHashes:[{hash,expiresAt}...],
//                                  linkToken, createdAt, expiresAt, attempts }
//     — the one active verification record for this account. A fresh
//       createVerification() call CARRIES FORWARD the still-valid recent
//       codes and appends the new one, keeping a rolling window of the last
//       MAX_ACTIVE_CODES (see "MULTIPLE RECENT CODES" below). The link
//       token is still latest-only (a fresh call mints a new one and
//       orphans the previous, same "retried signup self-heals" posture as
//       account-store.js's own createAccount).
//
// MULTIPLE RECENT CODES (fix, founder repro 2026-08-08): each send used to
// OVERWRITE the single stored `codeHash`, so the moment a newer code was
// sent every earlier one silently stopped verifying. That collided badly
// with js/email-verify-sheet.js's autoSendOnOpen (added 2026-08-07 —
// opening the verify sheet auto-sends a fresh code): a user with several
// verification emails in their inbox (signup + each sheet-open/resend,
// minutes apart) who typed an OLDER-but-real code got "that code didn't
// match", because only the single latest hash was ever checked. verifyCode
// now accepts a match against ANY of the last MAX_ACTIVE_CODES codes still
// within their own TTL, so a slightly-stale code the user legitimately
// received still works. This barely widens the brute-force surface (a
// handful of valid targets out of 1,000,000, and MAX_CODE_ATTEMPTS still
// caps total wrong guesses), while removing a real, founder-hit failure.
// Records written before this change carried a single `codeHash` field
// instead of `codeHashes` — both verifyCode and createVerification read
// that legacy shape transparently (see activeCodeEntries).
//   "t:<link token>" -> "<normalized username>"
//     — secondary index, same shape/reasoning as account-store.js's "e:"
//       email index: resolves a bare token (all verify-email-link.js has
//       on hand) back to the account it belongs to, without scanning.
//
// The code itself is stored HASHED (sha256), never in plaintext — same
// "don't keep a secret at rest in a form that's directly usable if the
// store is ever read some other way" discipline this codebase doesn't
// otherwise apply to passwords (see account-store.js's own header comment
// on why plaintext passwords are an accepted, pre-existing tradeoff there)
// but costs nothing extra to do properly for a BRAND NEW piece of secret
// state that has no such legacy to match. The link token is NOT hashed —
// unlike the code (a short, guessable 6-digit value an attacker could brute
// force against a stored hash if they somehow read the raw record), the
// link token is a full 32-byte random value (crypto.randomBytes(32), same
// entropy as every other token in this codebase — lib/session-transfer-
// token.js, lib/account-auth-token.js) that is only ever meaningful as a
// literal string comparison via its own "t:" index lookup, exactly like
// request-password-reset.js's own reset token is stored as the literal
// Blobs KEY, not hashed either.
//
// ATTEMPT LIMITING: verifyCode below caps the number of WRONG guesses at
// MAX_CODE_ATTEMPTS before refusing further attempts against this record
// entirely (the record itself is left in place — expiresAt still governs
// when a client can request a fresh code via a resend, which overwrites
// this record and resets the counter) — a 6-digit code has only 1,000,000
// possible values, so unlimited guessing against a single record would be
// a real brute-force surface without this.

var { getStore, connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');

var STORE_NAME = 'dreamtube-email-verifications';
// Generous — this app's whole design point is DEFERRING verification to
// "a natural later moment" (next visit, before publish, before purchase),
// which could genuinely be days after signup, not the usual short
// password-reset-style window. 7 days.
var TTL_MS = 7 * 24 * 60 * 60 * 1000;
var MAX_CODE_ATTEMPTS = 8;
// How many of the most-recent codes stay simultaneously valid (see the
// "MULTIPLE RECENT CODES" header note). Small on purpose: enough to cover
// a real user with a few verification emails open at once (signup + a
// couple of sheet-open/resend sends), without meaningfully enlarging the
// brute-force surface a single 6-digit code already presents.
var MAX_ACTIVE_CODES = 3;

function store() {
  return getStore({ name: STORE_NAME });
}

function normalizeUsername(username) {
  return (typeof username === 'string' ? username : '').trim().toLowerCase();
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

/** Generates a random 6-digit code, zero-padded (e.g. "004821"), matching the "6-digit code" spec literally rather than a 6-digit NUMBER that could start with a leading digit 1-9 only. */
function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * The still-valid code hashes on a record, newest last — the rolling
 * window verifyCode matches against and createVerification carries forward
 * (see the "MULTIPLE RECENT CODES" header note). Transparently reads BOTH
 * the current `codeHashes:[{hash,expiresAt}]` shape and the legacy single
 * `codeHash` field written before this change (treated as a one-entry
 * window governed by the record's own expiresAt), so an in-flight record
 * minted by the old code still verifies after this deploys.
 */
function activeCodeEntries(record, now) {
  if (!record) return [];
  if (Array.isArray(record.codeHashes)) {
    return record.codeHashes.filter(function (e) {
      return e && typeof e.hash === 'string' && (typeof e.expiresAt !== 'number' || e.expiresAt > now);
    });
  }
  if (typeof record.codeHash === 'string' && record.codeHash) {
    return [{ hash: record.codeHash, expiresAt: record.expiresAt }];
  }
  return [];
}

/**
 * Mints a fresh code + link token for `username`/`email`, overwriting any
 * previous still-pending verification for this account (see header
 * comment). Returns { ok:true, code, linkToken } — `code` is the raw,
 * unhashed 6-digit string, returned ONLY so the caller (lib/
 * verification-email-sender.js) can put it in the outbound email; it is
 * never stored in plaintext anywhere.
 */
async function createVerification(event, username, email) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'username_required' };
  connectLambda(event);
  var s = store();

  var code = randomCode();
  var linkToken = crypto.randomBytes(32).toString('hex');
  var now = Date.now();

  // Rolling window: carry forward whatever prior codes are still valid,
  // append this fresh one, keep only the last MAX_ACTIVE_CODES (see the
  // "MULTIPLE RECENT CODES" header note). An expired existing record
  // contributes nothing (a genuinely fresh start). attempts resets to 0,
  // same as the old full-overwrite behaviour — a legitimate resend
  // restores the user's guesses, and both entry points that mint codes are
  // themselves authToken-gated + IP-rate-limited.
  var existing = await s.get('u:' + key, { type: 'json' });
  var priorEntries = (existing && (typeof existing.expiresAt !== 'number' || existing.expiresAt > now))
    ? activeCodeEntries(existing, now) : [];
  var codeHashes = priorEntries
    .concat([{ hash: hashCode(code), expiresAt: now + TTL_MS }])
    .slice(-MAX_ACTIVE_CODES);

  await s.setJSON('u:' + key, {
    email: email, codeHashes: codeHashes, linkToken: linkToken,
    createdAt: (existing && existing.createdAt) ? existing.createdAt : now,
    expiresAt: now + TTL_MS, attempts: 0
  });
  await s.setJSON('t:' + linkToken, key);

  return { ok: true, code: code, linkToken: linkToken };
}

/**
 * Returns the CURRENT pending verification's link token for `username`,
 * minting a fresh one (via createVerification) if none exists yet or the
 * existing one has expired. Used by lib/verification-email-sender.js's
 * resend path, and by anything that wants to hand out an implicit-
 * verification link without necessarily also re-sending a fresh code
 * (kept as a thin wrapper for that future use rather than duplicating
 * createVerification's own logic) — today every real caller goes through
 * createVerification directly (a resend legitimately wants a fresh code
 * too, not just a fresh link), so this exists mainly as documented, tested
 * surface for that narrower need rather than something currently wired in.
 */
async function getOrCreateLinkToken(event, username, email) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'username_required' };
  connectLambda(event);
  var record = await store().get('u:' + key, { type: 'json' });
  if (record && record.expiresAt > Date.now()) {
    return { ok: true, linkToken: record.linkToken };
  }
  var created = await createVerification(event, key, email);
  if (!created.ok) return created;
  return { ok: true, linkToken: created.linkToken };
}

/**
 * Checks `code` against `username`'s pending verification. Returns
 * { ok:true } on a match (the record is deleted — both the "u:" record
 * and its "t:" index entry — since verification is now complete and there
 * is nothing left to guess against), or { ok:false, error } where error is
 * 'not_found' (no pending verification for this account — e.g. already
 * verified, or never sent one), 'expired' (past its TTL — also deletes the
 * stale record while here), or 'too_many_attempts' (see MAX_CODE_ATTEMPTS
 * above) or 'incorrect_code' (a real wrong guess — increments the attempt
 * counter on the way out).
 */
async function verifyCode(event, username, code) {
  var key = normalizeUsername(username);
  if (!key) return { ok: false, error: 'not_found' };
  connectLambda(event);
  var s = store();

  var record = await s.get('u:' + key, { type: 'json' });
  if (!record) return { ok: false, error: 'not_found' };
  if (record.expiresAt < Date.now()) {
    await deleteVerification(s, key, record.linkToken);
    return { ok: false, error: 'expired' };
  }
  if ((record.attempts || 0) >= MAX_CODE_ATTEMPTS) {
    return { ok: false, error: 'too_many_attempts' };
  }

  var candidateHash = hashCode(typeof code === 'string' ? code.trim() : '');
  var candidateBuf = Buffer.from(candidateHash);
  // Match against ANY still-valid code in the rolling window (see the
  // "MULTIPLE RECENT CODES" header note) — not just the newest, so a
  // slightly-stale but real code still verifies. Constant-time compare per
  // entry — same reasoning as facebook-oauth-callback.js's safeEqual for
  // its CSRF nonce — and the loop never short-circuits (a match on an
  // OLDER code takes the same time as one on the newest), keeping that
  // guarantee across the whole window.
  var entries = activeCodeEntries(record, Date.now());
  var match = false;
  for (var i = 0; i < entries.length; i++) {
    var storedHash = entries[i].hash;
    if (candidateHash.length === storedHash.length &&
        crypto.timingSafeEqual(candidateBuf, Buffer.from(storedHash))) {
      match = true;
    }
  }

  if (!match) {
    await s.setJSON('u:' + key, Object.assign({}, record, { attempts: (record.attempts || 0) + 1 }));
    return { ok: false, error: 'incorrect_code' };
  }

  await deleteVerification(s, key, record.linkToken);
  return { ok: true };
}

/**
 * Resolves `token` (from a clicked email link) back to the username it was
 * minted for, and deletes the record — same "verification is now complete,
 * nothing left to prove" cleanup as verifyCode's success path. Returns
 * { ok:true, username } or { ok:false, error:'invalid_or_expired' } for
 * anything else (unknown token, or the record it points at is somehow
 * gone/expired — treated identically, no reason to distinguish for the
 * caller).
 */
async function verifyLinkToken(event, token) {
  var raw = (typeof token === 'string' ? token : '').trim();
  if (!raw) return { ok: false, error: 'invalid_or_expired' };
  connectLambda(event);
  var s = store();

  var key = await s.get('t:' + raw, { type: 'json' });
  if (!key) return { ok: false, error: 'invalid_or_expired' };
  var record = await s.get('u:' + key, { type: 'json' });
  // Defense in depth, same "never trust an index blindly" posture as
  // account-store.js's getByEmail — a record whose OWN linkToken doesn't
  // match what the index pointed at (e.g. a resend minted a fresh token,
  // orphaning this exact one) is treated as not found, not a rewind to the
  // stale value.
  if (!record || record.linkToken !== raw) return { ok: false, error: 'invalid_or_expired' };
  if (record.expiresAt < Date.now()) {
    await deleteVerification(s, key, record.linkToken);
    return { ok: false, error: 'invalid_or_expired' };
  }

  await deleteVerification(s, key, record.linkToken);
  return { ok: true, username: key };
}

/** Deletes both keys for a verification record — shared cleanup helper for every path above that's done with one (success, expiry). */
async function deleteVerification(s, key, linkToken) {
  await s.delete('u:' + key);
  if (linkToken) await s.delete('t:' + linkToken);
}

module.exports = {
  STORE_NAME, TTL_MS, MAX_CODE_ATTEMPTS, MAX_ACTIVE_CODES,
  createVerification, getOrCreateLinkToken, verifyCode, verifyLinkToken
};
