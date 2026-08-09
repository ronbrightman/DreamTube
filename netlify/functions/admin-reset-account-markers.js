// netlify/functions/admin-reset-account-markers.js
//
// OWNER-ONLY TESTING TOOL — "genuine fresh start" reset for a single email
// (founder-authorized 2026-08-08). Clears the stale, once-ever markers that
// normal account deletion deliberately LEAVES behind, so the founder can
// delete his own test account and re-sign-up as if the email were brand new
// (a real 220-token base grant re-materializes, and the install/verify-email
// bonuses become claimable again).
//
// WHY THIS IS A SEPARATE ENDPOINT AND NOT A CHANGE TO delete-account.js:
// on a NORMAL deletion, the once-ever markers below MUST survive — if they
// were cleared on every deletion, any real user could delete their account
// and immediately re-sign-up to re-farm the base signup grant plus every
// bonus, indefinitely, with nothing but disposable emails. That anti-farm
// protection stays exactly as-is for real users (delete-account.js is
// untouched by this file). The "clean slate" is gated to the founder alone,
// behind the SAME real-password + OWNER_EMAIL bar every heavier admin tool
// uses (see admin-media-library-data.js / admin-diagnose-*.js), and only
// ever acts on the ONE email explicitly typed into admin.html's reset
// section.
//
// WHAT IT CLEARS, for the target email:
//   1. The entitlement record itself (entitlements.deleteEntitlement) — the
//      token balance / firstClaimAt / inner `achievements` ledger, plus the
//      outer achievement dedup markers for every achievement that record
//      lists. This is the same teardown delete-account.js already does for
//      the token-ledger half of a real deletion; doing it here makes the
//      reset self-contained (the founder doesn't have to also run the normal
//      delete first, though it's harmless if he did — deleting an
//      already-gone record is a safe no-op).
//   2. The two NAMED outer achievement markers — home_install_verified and
//      email_verified_bonus — explicitly, in case step 1 found no record to
//      enumerate them from (i.e. the founder already deleted the account
//      through the normal flow, which removed the record). Belt-and-braces:
//      whichever order the founder does things in, these two markers end up
//      cleared so both bonuses are re-earnable.
//   3. The token-init-grant:<email> marker (dreamtube-rate-limits store) —
//      THE essential piece. This is the once-ever marker syncTokens writes
//      the first time an email is ever granted its base balance, and the one
//      thing normal deletion never touches (see entitlements.js's REPLAY
//      GUARD doc block). While it exists, a re-signup only ever ECHOES the
//      old granted balance and re-materializes nothing; clearing it lets
//      syncTokens' first-ever-read branch run again and genuinely re-grant.
//   4. Today's per-email daily rate-limit buckets (claim-email /
//      claim-email-first / install-bonus-email) — so an immediate re-test's
//      claims/bonus aren't 429'd by counters the founder already spent today.
//      (The per-IP token-init counter is keyed by IP, not email, so it can't
//      be cleared per-email here — not needed for a fresh EMAIL anyway.)
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields        — usernameOrEmail / password / targetEmail
//                               not all present
//   E5 forbidden             — credentials didn't verify as the owner
//   E6 rate_limited

var entitlements = require('./lib/entitlements');
var accountStore = require('./lib/account-store');
var rateLimit = require('./lib/rate-limit');
var { normalizeEmail } = entitlements;

// The two named outer achievement markers to clear. email_verified_bonus is
// exported from entitlements.js (its own constant); home_install_verified is
// owned by claim-install-bonus.js (its ACHIEVEMENT_ID) — referenced here as
// a literal with this pointer since that file exports only its handler. If a
// third user-facing bonus achievement is ever added, list it here too.
var INSTALL_ACHIEVEMENT_ID = 'home_install_verified'; // = claim-install-bonus.js's ACHIEVEMENT_ID

/** Real, server-verified credential check + owner-email confirmation — same shape as admin-media-library-data.js's own copy, see that file's header comment. */
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
  var targetEmail = normalizeEmail(payload.targetEmail);
  if (!usernameOrEmail || !password || !targetEmail) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_RESET_MARKERS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 200;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-reset-account-markers-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var cleared = [];
  try {
    // 1. Entitlement record (balance / firstClaimAt / inner achievements) +
    //    the outer markers for whatever achievements that record listed.
    await entitlements.deleteEntitlement(event, targetEmail);
    cleared.push('entitlement_record');

    // 2. The two NAMED outer achievement markers, explicitly (covers the
    //    "founder already deleted the account first" order — see header).
    await entitlements.deleteAchievementGrantMarker(event, targetEmail, INSTALL_ACHIEVEMENT_ID);
    await entitlements.deleteAchievementGrantMarker(event, targetEmail, entitlements.EMAIL_VERIFIED_ACHIEVEMENT_ID);
    cleared.push('achievement_marker:' + INSTALL_ACHIEVEMENT_ID);
    cleared.push('achievement_marker:' + entitlements.EMAIL_VERIFIED_ACHIEVEMENT_ID);

    // 3. The once-ever base-grant marker normal deletion deliberately leaves
    //    — the essential piece that lets a re-signup genuinely re-grant.
    await rateLimit.deleteMarker(event, 'token-init-grant:' + targetEmail);
    cleared.push('token-init-grant');

    // 4. Today's per-email daily rate-limit buckets, so an immediate re-test
    //    isn't 429'd by counters already spent today.
    await rateLimit.clearDailyCount(event, 'claim-email', targetEmail);
    await rateLimit.clearDailyCount(event, 'claim-email-first', targetEmail);
    await rateLimit.clearDailyCount(event, 'install-bonus-email', targetEmail);
    cleared.push('daily-buckets');

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, targetEmail: targetEmail, cleared: cleared })
    };
  } catch (e) {
    console.error('admin-reset-account-markers: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'reset_failed: ' + (e && e.message), cleared: cleared }) };
  }
};
