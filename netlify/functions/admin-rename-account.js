// netlify/functions/admin-rename-account.js
//
// ONE-OFF, HARDCODED data-correction endpoint: renames the account
// currently stored under u:__probe_throwaway_user__ to u:ronbrightman.
// See tracker.html's for-product-correct-founder-account-user-flutrx item:
// during earlier testing the founder's own real account ended up under the
// literal username "__probe_throwaway_user__" (a privacy-browser/extension
// autocomplete injection — see register-account.js's E10 suspicious_username
// check, added afterward to stop this happening again). He's explicitly
// confirmed (2026-07-26 night) he wants it renamed to "ronbrightman".
//
// NOT a general "rename any account" tool — SOURCE_USERNAME/TARGET_USERNAME
// below are hardcoded constants, not request parameters, deliberately. A
// self-serve rename feature stays unbuilt unless separately asked for (see
// the tracker item's own explicit scope note) — this file's only job is to
// perform this one specific correction, safely and idempotently, then stay
// around as a record of what was done (or be deleted once it's clearly no
// longer needed — see the tracker item for that follow-up decision).
//
// AUTH: real, server-verified password (lib/account-store.js's verifyLogin)
// checked against the resolved account's own on-file email — NOT
// admin-paywall-toggle.js's/owner-topup-tokens.js's lighter "trust the
// client-supplied email" pattern. This mirrors the bar the sibling
// verify-owner-bypass.js endpoint (built alongside this one, on its own
// branch — see lib/owner-bypass.js's header comment for the identical
// reasoning) sets for anything that can cause REAL, hard-to-reverse
// consequences: admin-paywall-toggle.js/owner-topup-tokens.js only ever
// flip a flag or credit the OWNER'S OWN balance, both trivially reversible
// and scoped to accounts the caller already owns either way. This endpoint
// deletes an account record — a client that merely CLAIMED OWNER_EMAIL in a
// request body (the lighter pattern's whole tradeoff) could otherwise
// destroy the founder's own account data with no password at all. Real
// password verification is the correct bar here, same conclusion
// lib/owner-bypass.js's header comment reaches for the generation-rate-limit
// bypass, for the same underlying reason (real, consequential risk beats
// the lighter pattern's convenience).
//
// Deliberately does NOT require('./lib/owner-bypass') even though that
// module (on a separate, not-yet-merged branch as of this writing) already
// implements this exact "verify real password, check email against
// OWNER_EMAIL" check — depending on it here would couple this branch's
// mergeability to that other branch's merge order, for a module whose real
// purpose (minting a revisitable, TTL'd BYPASS TOKEN for repeated use across
// a testing session) has nothing to do with this file's actual need (one
// single, one-shot authorization check, never reused). The ~10-line
// credential check is duplicated inline below instead — matching this
// codebase's own explicit precedent (see lib/job-owners.js's header comment
// on why a small shared check gets duplicated across self-contained files
// rather than introducing a cross-branch/cross-module coupling) — and both
// copies can be reconciled (e.g. this file switching to require the shared
// module) after both branches land, if that's still worth doing then.
//
// SAFETY MODEL (read before touching this file):
//   1. Refuses to do anything unless the source account's own on-file email
//      matches OWNER_EMAIL (normalized) — this is the single most important
//      check here. A blind rename-by-username with no email cross-check
//      would silently corrupt a DIFFERENT real account if this were ever
//      run against the wrong source username (e.g. a future copy-paste
//      mistake), with no way to notice after the fact.
//   2. Refuses to overwrite an unrelated, already-existing u:ronbrightman
//      account (one whose email does NOT match the source account's own
//      email) — never a silent clobber.
//   3. RESUMABLE: because Netlify Blobs offers no cross-key transaction
//      primitive (same limitation lib/account-store.js's own header comment
//      documents at length), the three writes below (write target record ->
//      update the e: email index -> delete the source record) cannot be one
//      atomic operation. They're ordered so that at EVERY possible
//      interruption point (crash, timeout, redeploy mid-request) the
//      account is still fully resolvable by at least one live key, and a
//      retried call always converges to the same correct end state without
//      ever mistaking its own half-finished work for an unrelated
//      collision:
//        - Before any write: source is untouched, fully functional.
//        - After writing the target record, before updating the index: BOTH
//          u:ronbrightman and u:__probe_throwaway_user__ now exist with the
//          same email. The email index still points at the OLD username, so
//          login-by-email still resolves correctly via the untouched source
//          record — no lockout. A retry sees "target exists, same email as
//          source" and recognizes this as ITS OWN prior partial write (see
//          "resumable" case below), not a real collision, and simply
//          finishes the remaining steps.
//        - After updating the index, before deleting the source: the index
//          now correctly resolves to the new username; the old record is a
//          harmless, soon-to-be-deleted duplicate. A retry still sees
//          "source exists, target exists, same email" and finishes by
//          deleting the source (idempotent — deleting an already-deleted
//          key is a no-op).
//        - After deleting the source: fully done. A retry sees "source
//          missing, target exists" and reports status:'already_done' —
//          a safe, confusing-error-free no-op, not a failure.
//      The one case this deliberately does NOT try to auto-resolve: target
//      exists with a DIFFERENT email than the source. That can only mean a
//      genuinely separate, unrelated account already owns "ronbrightman" —
//      refused outright (status:'target_taken'), since createAccount's own
//      email-uniqueness check (lib/account-store.js) means the source
//      account's email can never legitimately equal a real DIFFERENT
//      account's email at the same time, so "different email" here can only
//      mean "not us".
//
// FEED DATA (tracker item's own explicit callout — "dreams reference author
// username in the feed"): after the account rename settles (freshly done,
// resumed, or already done), this also rewrites any dreamtube-feed
// feed-index entries whose ownerHandle is "@__probe_throwaway_user__" to
// "@ronbrightman" (see publish-dream.js/get-feed.js for that store's shape;
// js/store.js's handle format is always '@' + username). Idempotent — a
// second run finds nothing left to rewrite.
//
// entitlements.js (token balance) is confirmed EMAIL-keyed, not
// username-keyed (see that file's own header comment — one record per
// normalized email) — verified by reading the file directly, not assumed
// from the tracker item's claim. Nothing to migrate there: the founder's
// token balance already lives under his email and is completely unaffected
// by a username rename.
//
// KNOWN, ACCEPTED GAP — lib/dream-share-token.js: share-link records also
// carry a `ownerHandle` snapshot (stamped at share-time, e.g. by
// send-first-dream-email.js), but that store is keyed by random unguessable
// tokens with no cheap way to enumerate/filter existing entries (the same
// "Blobs has no query/scan API cheap enough to rely on here" limitation
// lib/account-store.js's own header comment documents), and each record is
// a 30-day-TTL'd cosmetic display snapshot, not a live reference — a stale
// entry just means a previously-emailed retention link could show the old
// handle as the display name for up to 30 days, never a broken/dead link.
// Realistically empty for this literal throwaway test account (it requires
// an actual first-dream retention email to have fired for it) and out of
// scope for this one-off fix regardless — not touched here.
//
// CLIENT-SIDE STALENESS: js/store.js's state.user (the handle shown in the
// UI) is set once, at login() time, from whatever username the SERVER
// returns (see that function's own `serverUsername`/`displayUsername`
// handling) and persists in localStorage until the next login/logout — it
// is never silently re-synced on page load. So the founder's own
// browser(s) will keep showing "@__probe_throwaway_user__" until he next
// logs in — a NORMAL re-login (by username "ronbrightman" OR by his email,
// both work via account-login.js's usernameOrEmail resolution) is
// sufficient to pick up the new username with no code change needed, since
// login() always overwrites state.user with the server's fresh response.
// One caveat worth flagging: on a device where the OLD username is still
// cached in state.accounts locally, attempting to log in by literally
// typing "__probe_throwaway_user__" would (correctly, but confusingly)
// still succeed via login()'s local-fallback path once the server no
// longer recognizes that username — logging in with his EMAIL or the NEW
// username avoids that ambiguity entirely, so that's the recommended way
// to re-login after this runs.
//
// Request: POST { usernameOrEmail, password, dryRun? }
//   usernameOrEmail/password: real credentials, checked via
//     lib/account-store.js's verifyLogin (username OR email both work, same
//     as account-login.js) — pass the founder's EMAIL here, since his
//     CURRENT username is the one being replaced.
//   dryRun (optional boolean): when true, performs the full auth check and
//     all read-side safety checks, and reports exactly what WOULD happen,
//     but makes no writes at all — lets the driving session preview this
//     against real production data before committing to the mutation, per
//     this task's own "actually invoking it... with its own sanity
//     confirmation" plan.
//
// Response: 200 { ok:true, dryRun, status, account?, feed? }
//   status one of:
//     'renamed'       — fresh rename performed (or would be, under dryRun)
//     'resumed'       — a previous partial run's target record was found
//                        (same email as source) and the remaining steps
//                        were completed (or would be, under dryRun)
//     'already_done'  — source is already gone and target already exists;
//                        nothing to do
//     'nothing_to_do' — neither source nor target exists; the throwaway
//                        account was never there (or this already ran and
//                        something else since deleted the target — treated
//                        the same, safely, as "nothing for this endpoint to
//                        do")
//   account: { username, email } of the resulting/would-result account,
//     present for 'renamed'/'resumed'/'already_done'.
//   feed: { updatedCount, dreamIds } — how many feed entries were (or
//     would be) rewritten.
// 409 { ok:false, error } for the two refusal cases:
//   E7: source_email_mismatch — the source account's own on-file email is
//       NOT the owner's email. Refuses to touch anything. This should
//       never happen in practice (nothing else can be at u:
//       __probe_throwaway_user__) but is the one check this whole file
//       exists to enforce, so it's absolute.
//   E8: target_taken — u:ronbrightman already exists under a DIFFERENT
//       email than the source account. Refuses to overwrite it.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js/owner-topup-tokens.js/verify-owner-bypass.js):
//   E1 method_not_allowed — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json
//   E4 missing_fields — usernameOrEmail/password not both present
//   E5 forbidden — covers every credential-check failure (no matching
//       account, wrong password, or a real account that simply isn't the
//       owner) without distinguishing which, same "don't help an attacker
//       enumerate accounts" reasoning verify-owner-bypass.js's own single
//       E5 already uses
//   E6 rate_limited — too many attempts (per-IP or per-identifier) today
//   E7 source_email_mismatch — see above
//   E8 target_taken — see above

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var SOURCE_USERNAME = accountStore.normalizeUsername('__probe_throwaway_user__');
var TARGET_USERNAME = accountStore.normalizeUsername('ronbrightman');

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

function accountsStore() {
  return getStore({ name: accountStore.STORE_NAME });
}

/**
 * Real, server-verified credential check + owner-email confirmation.
 * Duplicated (deliberately — see header comment) from the same-shaped
 * check lib/owner-bypass.js's verifyOwnerCredentials performs on its own
 * branch. Returns { ok:true, record } or { ok:false, error }, error one of
 * 'owner_not_configured' / 'not_found' / 'incorrect_password' / 'not_owner'.
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
 * Rewrites any dreamtube-feed feed-index entries whose ownerHandle is
 * "@<sourceUsername>" to "@<targetUsername>". Idempotent — a run that
 * finds no matches makes no write at all. `dryRun` reports what WOULD be
 * rewritten without writing anything.
 */
async function migrateFeedOwnerHandle(event, dryRun) {
  connectLambda(event);
  var feedStore = getStore(FEED_STORE_NAME);
  var feed = (await feedStore.get(FEED_KEY, { type: 'json' })) || [];
  var sourceHandle = '@' + SOURCE_USERNAME;
  var targetHandle = '@' + TARGET_USERNAME;

  var matchedIds = [];
  var rewritten = feed.map(function (dream) {
    var handle = typeof dream.ownerHandle === 'string' ? dream.ownerHandle.toLowerCase() : '';
    if (handle !== sourceHandle) return dream;
    matchedIds.push(dream.id);
    return Object.assign({}, dream, { ownerHandle: targetHandle });
  });

  if (matchedIds.length && !dryRun) {
    await feedStore.setJSON(FEED_KEY, rewritten);
  }
  return { updatedCount: matchedIds.length, dreamIds: matchedIds };
}

/**
 * The actual rename decision + (unless dryRun) mutation, following the
 * resumable write-ordering laid out in the header comment. Returns
 * { httpStatus, body }.
 */
async function performRename(event, ownerEmail, dryRun) {
  connectLambda(event);
  var s = accountsStore();

  var sourceRecord = await accountStore.getByUsername(event, SOURCE_USERNAME);
  var targetRecord = await accountStore.getByUsername(event, TARGET_USERNAME);

  if (!sourceRecord) {
    if (targetRecord) {
      var feedAlreadyDone = await migrateFeedOwnerHandle(event, dryRun);
      return {
        httpStatus: 200,
        body: {
          ok: true, dryRun: !!dryRun, status: 'already_done',
          account: { username: targetRecord.username, email: targetRecord.email },
          feed: feedAlreadyDone
        }
      };
    }
    return {
      httpStatus: 200,
      body: { ok: true, dryRun: !!dryRun, status: 'nothing_to_do', account: null, feed: { updatedCount: 0, dreamIds: [] } }
    };
  }

  // The one check this whole file exists to enforce: never touch anything
  // unless the source account's own on-file email really is the owner's.
  var sourceEmail = normalizeEmail(sourceRecord.email);
  if (sourceEmail !== ownerEmail) {
    return { httpStatus: 409, body: { ok: false, error: 'E7: source_email_mismatch' } };
  }

  var status;
  if (targetRecord) {
    var targetEmail = normalizeEmail(targetRecord.email);
    if (targetEmail !== sourceEmail) {
      // A genuinely different, unrelated account already owns
      // "ronbrightman" -- refuse outright, never overwrite.
      return { httpStatus: 409, body: { ok: false, error: 'E8: target_taken' } };
    }
    // Same email as the source -- this can only be our own prior partial
    // run (createAccount's own email-uniqueness check rules out two
    // genuinely different accounts sharing this email). Finish the
    // remaining steps rather than refusing.
    status = 'resumed';
  } else {
    status = 'renamed';
    if (!dryRun) {
      var newRecord = Object.assign({}, sourceRecord, {
        username: TARGET_USERNAME,
        updatedAt: Date.now(),
        renamedFrom: SOURCE_USERNAME,
        renamedAt: Date.now()
      });
      // Write ordering (see header comment): target record FIRST, so an
      // interruption right after this line still leaves the source fully
      // intact and resolvable, with a retry recognizing the new target as
      // its own prior work rather than a collision.
      await s.setJSON('u:' + TARGET_USERNAME, newRecord);
    }
  }

  if (!dryRun) {
    // Index next, source delete last -- see header comment for why this
    // order is the one that's always safely resumable at every
    // interruption point.
    await s.setJSON('e:' + sourceEmail, TARGET_USERNAME);
    await s.delete('u:' + SOURCE_USERNAME);
  }

  var feedResult = await migrateFeedOwnerHandle(event, dryRun);
  var resultingRecord = { username: TARGET_USERNAME, email: sourceEmail };
  return { httpStatus: 200, body: { ok: true, dryRun: !!dryRun, status: status, account: resultingRecord, feed: feedResult } };
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
  var dryRun = payload.dryRun === true;
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  // Same two-bucket (per-IP + per-identifier) rate limiting as
  // verify-owner-bypass.js, and for the identical reason: this endpoint
  // performs a real password check against ONE specific, high-value
  // account, so an unlimited number of guesses against it must never be
  // possible regardless of source IP. The per-identifier bucket is keyed
  // on the canonical account this specific credential pair resolves to
  // (same as verify-owner-bypass.js's own identifierKey), falling back to
  // the raw lowercased identifier if it doesn't resolve to a real account
  // at all.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_RENAME_ACCOUNT_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_RENAME_ACCOUNT_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-rename-account-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-rename-account-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var result = await performRename(event, ownerEmail, dryRun);
  return { statusCode: result.httpStatus, body: JSON.stringify(result.body) };
};
