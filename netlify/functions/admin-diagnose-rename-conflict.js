// netlify/functions/admin-diagnose-rename-conflict.js
//
// READ-ONLY diagnostic for tracker.html's
// for-product-rename-dry-run-refused-u-ron-rd0sm9 item: the founder ran
// admin-rename-account.js's dry run (2026-07-27) and got a correct refusal
// (E8 target_taken) because u:ronbrightman already exists as an account
// SEPARATE from u:__probe_throwaway_user__. Likely cause: usernames are
// auto-derived from the email local-part at signup, so his real signup with
// ronbrightman@gmail.com would have created u:ronbrightman at some point,
// making the probe-named account a second, distinct account of his own — but
// that's a hypothesis, not yet confirmed, and admin-rename-account.js's own
// E8 refusal deliberately reveals nothing about WHOSE account is sitting on
// "ronbrightman" or what either account actually holds.
//
// This function exists ONLY to answer that question, safely: what email is
// on file for each of the two usernames in play, and what data each holds,
// so a human (the founder, via tracker.html) can decide the right next step
// (transfer + delete, or something else entirely if u:ronbrightman turns out
// to be an unrelated real user). It performs NO writes of any kind, under
// any code path, to any Blobs key — this is a pure read/report, not a
// preview-of-a-mutation like admin-rename-account.js's own dryRun mode (that
// mode still runs every write-eligible code path with the actual setJSON/
// delete calls skipped; this file has no write-eligible code path to skip in
// the first place). Findings get posted to tracker.html by whoever runs
// this against production — NOT by this function itself, and NOT
// automatically — no action is taken here beyond reporting.
//
// SOURCE_USERNAME/TARGET_USERNAME are hardcoded constants, not request
// parameters, same one-off-tool reasoning as admin-rename-account.js's own
// header comment (this is the diagnostic sibling of that ONE specific
// rename, not a general "diagnose any two accounts" tool — that stays
// unbuilt unless separately asked for).
//
// AUTH: identical bar to admin-rename-account.js — real, server-verified
// password (lib/account-store.js's verifyLogin) checked against the
// resolved account's own on-file email matching OWNER_EMAIL, NOT the lighter
// "trust the client-supplied email" pattern admin-paywall-toggle.js/
// owner-topup-tokens.js use. Even though this endpoint never writes
// anything, it can READ another real user's account contents (email, token
// balance, published-dream count) if u:ronbrightman turns out to belong to
// someone unrelated — exactly the scenario this diagnostic exists to check
// for — so a bare client-claimed email would be a real information-
// disclosure hole, not just a theoretical one. verifyOwnerCredentials below
// is duplicated inline from admin-rename-account.js's own copy rather than
// factored into a shared module, matching this codebase's explicit
// precedent (see that file's header comment, and lib/job-owners.js's, for
// why a small shared check gets duplicated across self-contained Netlify
// Functions instead of introducing cross-file coupling).
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as
// admin-rename-account.js/verify-owner-bypass.js/account-login.js, and for
// the same reason — this performs a real password check against one
// specific, high-value identity, so unlimited guessing must never be
// possible regardless of source IP. This is the one deliberate, accepted
// exception to "no writes to any Blobs key": the rate-limit counter itself
// (lib/rate-limit.js, a separate "dreamtube-rate-limits" store, never the
// account/feed/entitlement data this function actually diagnoses) is
// bookkeeping every password-gated endpoint in this codebase performs,
// including admin-rename-account.js and account-login.js — omitting it here
// would leave this specific endpoint's own password check completely
// unthrottled even though the exact same underlying password is already
// throttled when guessed through account-login.js, which would be a
// meaningfully weaker posture for no real benefit. Every OTHER code path in
// this file (the actual account/email-index/feed lookups) makes zero Blobs
// writes, which is what this file's own tests assert.
//
// WHAT THIS CAN AND CANNOT SEE:
//   - email + password-record metadata for both usernames: lib/account-
//     store.js, read-only (getByUsername/getByEmail).
//   - token balance: lib/entitlements.js is confirmed EMAIL-keyed (see that
//     file's own header comment), read via getEntitlement — a genuinely
//     read-only lookup (unlike getTokenStatus/syncTokens, which lazily
//     GRANT and WRITE a balance on first read; deliberately NOT used here,
//     since that would mutate entitlements data as a side effect of a
//     'read-only' diagnostic).
//   - published-dream count: only dreams that made it into the shared
//     dreamtube-feed feed-index (see publish-dream.js/get-feed.js), matched
//     by ownerHandle, same "@" + username handle shape admin-rename-
//     account.js's own migrateFeedOwnerHandle already reads.
//   - PRIVATE (unpublished) dreams and ALL characters: per CLAUDE.md and
//     account-store.js's own header comment, js/store.js keeps
//     state.dreams/charactersByUser in each BROWSER's localStorage only —
//     there is no server-side store of either at all, for any account. This
//     function cannot see them and does not pretend a zero/missing count
//     means "no data" — it reports this limitation explicitly per account
//     instead of fabricating a number.
//
// Request: POST { usernameOrEmail, password } (real owner credentials).
// Response: 200 {
//   ok: true,
//   ownerEmail,
//   emailIndex: { key, rawTarget, resolvesToRecord },
//     // rawTarget: the literal username string the "e:<ownerEmail>" index
//     //   currently points at (or null if no index entry exists at all) —
//     //   read directly, NOT through getByEmail's defense-in-depth filter,
//     //   so a stale/mismatched index is visible here rather than silently
//     //   treated as "not found".
//     // resolvesToRecord: what getByEmail's own validated resolution
//     //   returns (null if the index is stale/missing/mismatched) — useful
//     //   to compare against rawTarget.
//   accounts: { probe: <summary>, target: <summary> }
//     // one summary per hardcoded username (SOURCE_USERNAME/
//     // TARGET_USERNAME below); { username, exists:false } if that account
//     // doesn't exist at all, otherwise { username, exists:true, email,
//     // updatedAt, renamedFrom, tokenBalance, publishedDreamCount,
//     // publishedDreamIds, notTrackedServerSide }.
// }
// 403 { ok:false, error: 'E5: forbidden' } — bad/unmatched credentials, or a
//   real account whose own email simply isn't OWNER_EMAIL (never
//   distinguished, same "don't help an attacker enumerate accounts"
//   reasoning admin-rename-account.js's own E5 uses).
// 429 { ok:false, error } — E6 rate_limited (see above).
// 500 { error: 'E2: missing_owner_email' } — OWNER_EMAIL not configured.
//
// Error codes (same small-number scheme as admin-rename-account.js/
// admin-paywall-toggle.js/owner-topup-tokens.js/verify-owner-bypass.js):
//   E1 method_not_allowed — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json
//   E4 missing_fields — usernameOrEmail/password not both present
//   E5 forbidden — covers every credential-check failure
//   E6 rate_limited — too many attempts today

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var entitlements = require('./lib/entitlements');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var SOURCE_USERNAME = accountStore.normalizeUsername('__probe_throwaway_user__');
var TARGET_USERNAME = accountStore.normalizeUsername('ronbrightman');

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

var NOT_TRACKED_SERVER_SIDE =
  'Private (unpublished) dreams and characters are never synced server-side ' +
  '(js/store.js keeps them in this browser\'s localStorage only, per ' +
  'account-store.js\'s own documented scope) -- invisible to this or any ' +
  'server-side diagnostic. publishedDreamCount below only reflects dreams ' +
  'that made it into the shared public feed.';

/**
 * Real, server-verified credential check + owner-email confirmation.
 * Duplicated (deliberately -- see header comment) from admin-rename-
 * account.js's own verifyOwnerCredentials. Returns { ok:true, record } or
 * { ok:false, error }, error one of 'owner_not_configured' / 'not_found' /
 * 'incorrect_password' / 'not_owner'.
 */
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

/**
 * Reads the shared feed-index once (read-only) and returns a counter
 * closure so both account summaries below can be built off the same single
 * read rather than fetching the feed twice.
 */
async function loadFeedCounter(event) {
  connectLambda(event);
  var feedStore = getStore(FEED_STORE_NAME);
  var feed = (await feedStore.get(FEED_KEY, { type: 'json' })) || [];
  return function countFor(username) {
    var handle = '@' + username;
    var matches = feed.filter(function (dream) {
      var h = typeof dream.ownerHandle === 'string' ? dream.ownerHandle.toLowerCase() : '';
      return h === handle;
    });
    return { count: matches.length, ids: matches.map(function (d) { return d.id; }) };
  };
}

/**
 * Builds the read-only summary for one hardcoded username. `record` is
 * whatever accountStore.getByUsername already returned for it (passed in
 * rather than re-fetched, so this stays a pure formatter with no Blobs
 * access of its own beyond the one entitlements read).
 */
async function summarizeAccount(event, username, record, countFor) {
  if (!record) {
    return { username: username, exists: false };
  }
  var entitlement = await entitlements.getEntitlement(event, record.email);
  var published = countFor(record.username);
  return {
    username: record.username,
    exists: true,
    email: record.email,
    updatedAt: record.updatedAt || null,
    renamedFrom: record.renamedFrom || null,
    tokenBalance: entitlement && entitlement.tokens ? entitlement.tokens.balance : null,
    publishedDreamCount: published.count,
    publishedDreamIds: published.ids,
    notTrackedServerSide: NOT_TRACKED_SERVER_SIDE
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

  // Same two-bucket (per-IP + per-identifier) rate limiting as
  // admin-rename-account.js, and for the identical reason -- see header
  // comment's "RATE LIMITING" section for why this is the one accepted
  // Blobs-write exception in an otherwise fully read-only function.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_RENAME_CONFLICT_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-rename-conflict-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-rename-conflict-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  // Everything below this line is a pure read -- no setJSON/delete call
  // exists anywhere past this point in this file.
  connectLambda(event);
  var accountsBlobsStore = getStore({ name: accountStore.STORE_NAME });

  var sourceRecord = await accountStore.getByUsername(event, SOURCE_USERNAME);
  var targetRecord = await accountStore.getByUsername(event, TARGET_USERNAME);

  var emailIndexKey = 'e:' + ownerEmail;
  var rawIndexTarget = (await accountsBlobsStore.get(emailIndexKey, { type: 'json' })) || null;
  var resolvedByEmail = await accountStore.getByEmail(event, ownerEmail);

  var countFor = await loadFeedCounter(event);
  var probeSummary = await summarizeAccount(event, SOURCE_USERNAME, sourceRecord, countFor);
  var targetSummary = await summarizeAccount(event, TARGET_USERNAME, targetRecord, countFor);

  var body = {
    ok: true,
    ownerEmail: ownerEmail,
    emailIndex: {
      key: emailIndexKey,
      rawTarget: rawIndexTarget,
      resolvesToRecord: resolvedByEmail ? { username: resolvedByEmail.username, email: resolvedByEmail.email } : null
    },
    accounts: { probe: probeSummary, target: targetSummary }
  };

  return { statusCode: 200, body: JSON.stringify(body) };
};
