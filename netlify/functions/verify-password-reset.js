// netlify/functions/verify-password-reset.js
//
// POST { token, consume, newPassword } -> checks a password-reset token
// stored by request-password-reset.js. With consume:false (default) this
// just peeks — used to decide whether to show the "set a new password"
// form at all, and to display the account's username on it. With
// consume:true it also deletes the token so it can't be reused.
//
// If `newPassword` is ALSO given alongside consume:true, this call now
// really does change the password — it writes it to the real server-side
// account store (lib/account-store.js) for the token's username/email,
// via applyPasswordReset. Before this, this function only ever proved a
// link was legitimate and unused; the actual password change happened
// exclusively in js/store.js's resetPasswordLocally, which only ever wrote
// to the current browser's own localStorage — meaning even a verified,
// legitimate reset token had nowhere server-side to actually take effect.
// See AGENT_POLICY.md / tracker.html's now-resolved
// accounts-dont-sync-across-devices item for the full story.
//
// applyPasswordReset UPSERTS: if this is the first time this token's
// username has ever been seen server-side (a pre-fix, local-only account
// that never registered there), this call is also the moment it gets
// backfilled into the real account store, using the email the reset was
// actually sent to — the same "materialize on first real write" shape
// this codebase already uses elsewhere (see entitlements.js/tracker-
// store.js's own lazy-materialize comments), just triggered by a
// verified reset instead of a first read.
//
// Omitting `newPassword` (or leaving consume:false) behaves exactly as
// before this change — a pure peek/consume with no account-store write at
// all. js/store.js's resetPasswordLocally now always sends both consume:
// true and newPassword together in one call (see that function) — there's
// no longer a separate "consume, then separately apply locally" round
// trip; this one call does both the real server-side write and hands back
// what's needed for the client to also refresh its own local mirror (see
// that function's own comment for why it still keeps one).
//
// Error codes:
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 token_required
//   E4 invalid_or_expired
//   E5 invalid_new_password  — newPassword was provided but wasn't a
//                               string of at least 8 characters (same
//                               minimum register-account.js enforces on
//                               signup) — checked before the token is
//                               even looked up, so a malformed request
//                               never touches Blobs at all.
//   E6 conflict              — applyPasswordReset detected a concurrent
//                               write to the same account (see
//                               lib/account-store.js's own narrowed-race
//                               comment) and safely declined rather than
//                               risk a corrupted/misdirected record. The
//                               token itself is still valid and NOT
//                               consumed on this path (even if `consume`
//                               was true) — safe for the caller to retry
//                               the exact same request.

var { connectLambda, getStore } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');

var RESET_STORE = 'dreamtube-password-resets';

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

  var token = (payload.token || '').trim();
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: token_required' }) };
  }

  var newPassword = payload.newPassword;
  var applyingNewPassword = newPassword !== undefined && newPassword !== null;
  if (applyingNewPassword && (typeof newPassword !== 'string' || newPassword.length < 8)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_new_password' }) };
  }

  try {
    connectLambda(event);
    var store = getStore(RESET_STORE);
    var record = await store.get(token, { type: 'json' });

    if (!record || record.expiresAt < Date.now()) {
      if (record) await store.delete(token); // expired — clean it up while we're here
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E4: invalid_or_expired' }) };
    }

    if (applyingNewPassword) {
      var resetResult = await accountStore.applyPasswordReset(event, {
        username: record.username,
        email: record.email,
        password: newPassword
      });
      if (!resetResult.ok) {
        // Leave the token untouched (never consumed on this path, even if
        // consume:true was requested) — a concurrent write raced this one
        // and won, so nothing was actually saved here; the caller can just
        // retry the identical request with the same still-valid token. See
        // the E6 doc block above.
        return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'E6: conflict' }) };
      }
    }

    if (payload.consume) await store.delete(token);

    return { statusCode: 200, body: JSON.stringify({ ok: true, username: record.username, email: record.email }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'verify_failed: ' + (e && e.message) }) };
  }
};
