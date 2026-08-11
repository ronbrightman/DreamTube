// netlify/functions/lib/derive-username.js
//
// The "derive an @handle from an email address, retrying with a random
// numeric suffix on collision" logic this app has used since signup was
// client-side-only. It exists here, server-side, because it is needed by
// netlify/functions/register-account-passwordless.js, which creates real
// accounts server-side with no user-chosen username on hand (the
// passwordless path derives the handle from the email), and a Netlify
// Function obviously cannot reach into start.html's or wizard.html's
// page-local <script> block for it.
//
// The two existing copies (start.html's deriveUsernameBase/attemptSignup
// and wizard.html's identical pair) are deliberately left alone for now:
// this codebase has no bundler and no ES modules (see CLAUDE.md), so a
// browser page cannot require() this file, and adding a *fourth* artifact
// (a parallel js/derive-username.js client script) purely to de-duplicate
// two eight-line functions would be more moving parts, not fewer. What
// this file does buy is that the SERVER-side account-creation path — the
// one that can create an account with no human watching the result — has
// exactly one implementation, unit-testable in isolation, instead of a
// hand-copied third variant drifting away from the other two. If/when the
// client pages are ever refactored to share a script, this file is the
// canonical shape to mirror.
//
// Behavior is intentionally IDENTICAL to start.html's/wizard.html's
// current implementations, character for character in the base-derivation
// rules, so an account created server-side (passwordless) gets the same
// kind of handle a manual signup with the same email would:
//   - local part of the email, lowercased
//   - every non [a-z0-9] character stripped
//   - padded with 'dreamer' if that leaves fewer than 3 characters
//   - truncated to 20 characters
//   - 'dreamer' as the final fallback if nothing at all survives (in
//     practice unreachable, since the pad-to-3 step above always leaves a
//     non-empty string — kept anyway so this stays bug-for-bug identical
//     to the two page copies rather than "fixed" into divergence)
// and on collision, a fresh 4-digit suffix appended to the BASE (not to
// the previous candidate — so handles never grow unboundedly), up to
// MAX_ATTEMPTS times.
//
// That "identical" claim is enforced, not just asserted: see
// test/passwordless-signup.test.js, which exercises this module's
// derivation against the same base rules the two page copies use.

var MAX_ATTEMPTS = 8;

/** Derives the collision-free-attempt-zero username from an email. Same rules as start.html's/wizard.html's own deriveUsernameBase — see this file's header comment. */
function deriveUsernameBase(email) {
  var local = ((typeof email === 'string' ? email : '').split('@')[0] || '').toLowerCase();
  var sanitized = local.replace(/[^a-z0-9]/g, '');
  if (sanitized.length < 3) sanitized = (sanitized + 'dreamer').slice(0, Math.max(3, sanitized.length + 4));
  return sanitized.slice(0, 20) || 'dreamer';
}

/** The random 4-digit collision suffix, matching start.html's/wizard.html's own `Math.floor(1000 + Math.random() * 9000)`. Exposed (and overridable via deriveAvailableUsername's options) purely so tests can make collision retries deterministic. */
function randomSuffix() {
  return Math.floor(1000 + Math.random() * 9000);
}

/**
 * Resolves an available username for `email`, asking the caller's own
 * `isTaken(candidate) -> Promise<boolean>` predicate about each candidate
 * in turn. Deliberately takes a predicate rather than require()-ing
 * lib/account-store.js directly: this file stays dependency-free and
 * trivially unit-testable, and the caller keeps full control over what
 * "taken" means (register-account-passwordless.js asks the real account
 * store; a test can answer from a plain object).
 *
 * Returns { ok:true, username } on success, or { ok:false,
 * error:'no_available_username' } if every attempt collided — which the
 * caller must treat as a real failure (fail closed), never as "create it
 * anyway".
 *
 * Options:
 *   maxAttempts   — collision retries after the base attempt (default 8,
 *                   same as start.html's/wizard.html's MAX_ATTEMPTS)
 *   randomSuffix  — override the suffix generator (tests only)
 */
async function deriveAvailableUsername(email, isTaken, options) {
  options = options || {};
  var maxAttempts = typeof options.maxAttempts === 'number' ? options.maxAttempts : MAX_ATTEMPTS;
  var suffixFor = typeof options.randomSuffix === 'function' ? options.randomSuffix : randomSuffix;

  var base = deriveUsernameBase(email);
  var candidate = base;
  for (var attempt = 0; attempt <= maxAttempts; attempt++) {
    if (!(await isTaken(candidate))) return { ok: true, username: candidate };
    candidate = base + suffixFor();
  }
  return { ok: false, error: 'no_available_username' };
}

module.exports = { MAX_ATTEMPTS, deriveUsernameBase, randomSuffix, deriveAvailableUsername };
