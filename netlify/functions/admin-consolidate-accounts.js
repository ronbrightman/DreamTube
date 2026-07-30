// netlify/functions/admin-consolidate-accounts.js
//
// ONE-OFF, HARDCODED data-correction endpoint for tracker.html's
// for-product-rename-dry-run-refused-u-ron-rd0sm9 item, following on from
// the sibling for-product-correct-founder-account-user-flutrx rename (see
// admin-rename-account.js). That rename tool's own dry run correctly
// refused (E8 target_taken) because u:ronbrightman already existed as a
// SEPARATE real account of the founder's own — admin-diagnose-rename-
// conflict.js then confirmed both accounts really are his:
//   u:__probe_throwaway_user__ — email ronbrightman@gmail.com (matches
//     OWNER_EMAIL), 1860 tokens, 2 published dreams (dqocagbs, dm6bujus)
//   u:ronbrightman             — email ronb.rightman@gmail.com (his own
//     dotted Gmail — same real inbox, confirmed by him to be the same
//     person), 200 tokens, 5 published dreams
//   e:ronbrightman@gmail.com currently resolves to the PROBE account.
// Founder resolution (relayed via Manager, tracker comments 2026-07-27 /
// 2026-07-28): keep u:ronbrightman as THE surviving account, but put
// OWNER_EMAIL (ronbrightman@gmail.com) on it — not admin-rename-account.js's
// job (that tool only ever renames __probe_throwaway_user__ to
// ronbrightman; here "ronbrightman" the USERNAME already exists and stays
// put, it's the ACCOUNT'S email/password/tokens/dreams that need merging).
//
// NOT a general "merge any two accounts" tool — every username/email below
// is a hardcoded constant, not a request parameter, same one-off-tool
// reasoning as admin-rename-account.js's own header comment. A self-serve
// account-merge feature stays unbuilt unless separately asked for.
//
// FINAL STATE THIS PRODUCES (all under the one surviving u:ronbrightman
// record):
//   1. username: ronbrightman (unchanged — this account already has that
//      username; this endpoint never touches its own key, "u:ronbrightman",
//      only rewrites the RECORD stored under it).
//   2. email: OWNER_EMAIL exactly (ronbrightman@gmail.com) — the founder's
//      hard requirement, since every owner gate in this codebase
//      (admin-paywall-toggle.js/owner-topup-tokens.js/verify-owner-bypass.js/
//      this file's own sibling tools/tracker-store.js's owner check) keys
//      off OWNER_EMAIL, never username. Because OWNER_EMAIL doesn't change
//      and nothing else in this codebase is username-keyed for owner
//      purposes (see the repo-wide grep this task was built against), every
//      owner surface keeps working the instant this account's email
//      matches OWNER_EMAIL — no separate step needed.
//   3. password: the PROBE account's real stored password (the account tied
//      to the email he actually knows/types day to day) — u:ronbrightman's
//      own prior password is discarded, per the founder's own explicit
//      instruction relayed via Manager.
//   4. e:ronbrightman@gmail.com (OWNER_EMAIL) index: repointed from the
//      probe username to "ronbrightman".
//   5. e:ronb.rightman@gmail.com (the dotted email) index: tombstoned
//      (deleted) — no account should resolve by that address anymore.
//   6. u:__probe_throwaway_user__: deleted entirely.
//   7. Tokens: BOTH entitlement balances (entitlements.js is confirmed
//      EMAIL-keyed, not username-keyed — read directly from that file's own
//      header comment, not assumed from the tracker item's claim) summed
//      onto the OWNER_EMAIL entitlement record. The dotted email's own
//      entitlement record has its balance drained to exactly 0 (not
//      deleted outright — see drainDottedEmailIntoOwner's own doc comment
//      for why zeroing, not deleting, is the safer move here).
//   8. Published dreams: the probe's feed entries get ownerHandle rewritten
//      from "@__probe_throwaway_user__" to "@ronbrightman" (reusing the
//      exact same feed-retag approach as admin-rename-account.js's own
//      migrateFeedOwnerHandle) — the account's own 5 pre-existing
//      "@ronbrightman" dreams are already correctly tagged and untouched.
//      All 7 published dreams survive under the one final handle.
//   9. Client-side: js/store.js's existing LEGACY_ACCOUNT_RENAME constant is
//      ALREADY exactly { fromUsername: '__probe_throwaway_user__',
//      toUsername: 'ronbrightman' } — the identical pair this consolidation
//      produces (this account was always going to end up at the username
//      "ronbrightman" either way, whether via the sibling rename tool or
//      this one). migrateLegacyThrowawayAccountData/pinLegacyRenameIdentity
//      (see js/store.js's own doc comments) already re-tag any
//      locally-cached dreams/characters still sitting under the old
//      "@__probe_throwaway_user__" handle onto "@ronbrightman" the moment
//      the founder's browser next logs in as ronbrightman — VERIFIED by
//      reading that mechanism directly (it keys purely off USERNAME, never
//      email, so it does not care which email ends up on the account) and
//      by a new end-to-end test for this specific pair/scenario (see
//      test/consolidate-accounts-client-migration-behavioral.test.js) —
//      genuinely no js/store.js code change needed for this task.
//
// AUTH: identical bar to admin-rename-account.js/admin-diagnose-rename-
// conflict.js — real, server-verified password (lib/account-store.js's
// verifyLogin) checked against the resolved account's own on-file email
// matching OWNER_EMAIL, never the lighter "trust the client-supplied email"
// pattern. This endpoint can move real token balances and delete a real
// account record, so a bare client-claimed email is not an acceptable bar
// here (same conclusion every sibling admin-*.js file in this codebase
// already reaches, and the same reason payments/webhooks in this repo now
// require a real password check before trusting a client-supplied identity
// — see client-trusted-email-at-checkout-now-ris-xxqf2s). Pass the account
// currently sitting on OWNER_EMAIL (today, the probe account) — its
// password is exactly what verifyLogin needs to check, and exactly the
// password this endpoint will carry forward onto the final account.
// verifyOwnerCredentials below is duplicated inline from admin-rename-
// account.js's own copy rather than factored into a shared module, matching
// this codebase's explicit precedent (see that file's header comment, and
// lib/job-owners.js's, for why a small shared check gets duplicated across
// self-contained Netlify Functions instead of introducing cross-file
// coupling).
//
// SANITY CHECKS — FAIL CLOSED, NEVER GUESS:
//   - The probe account's own on-file email must be EXACTLY OWNER_EMAIL.
//     Absolute, never skippable (mirrors admin-rename-account.js's own E7
//     — the single most important check in that file, and in this one).
//   - u:ronbrightman's own on-file email must be EXACTLY one of:
//       (a) EXPECTED_RONBRIGHTMAN_OLD_EMAIL (the dotted variant — the
//           normal, not-yet-run state), or
//       (b) OWNER_EMAIL itself (this consolidation already ran once and was
//           interrupted after updating the record but before finishing —
//           see RESUMABILITY below).
//     Anything else means u:ronbrightman is NOT the account this task was
//     diagnosed against — refuse outright (E8), never overwrite. Also
//     absolute, never skippable — this is an identity check, not a
//     snapshot-drift check (see the next bullet), and overriding it would
//     reopen exactly the "blind rename could corrupt a different real
//     account" hazard admin-rename-account.js's own header comment warns
//     about.
//   - Token balances / published-dream counts (both accounts) are compared
//     against the exact snapshot the founder's diagnose-panel run reported
//     (tracker item for-product-rename-dry-run-refused-u-ron-rd0sm9, the
//     2026-07-28 20:48 comment) — see EXPECTED_* constants below. Unlike
//     the two identity checks above, this IS allowed to be bypassed, via
//     the request's own explicit `skipSnapshotSanityChecks: true` flag —
//     because, unlike the identity fields, these numbers can legitimately
//     drift with time (a claim, a generation, a new publish since the
//     diagnosis ran) without indicating anything is actually wrong. The
//     flag exists so the controlling session isn't permanently stuck
//     re-deploying a constants bump every time real, ordinary product usage
//     moves these numbers — but it is OFF by default, so an operator who
//     runs this without first re-checking why the counts moved gets a
//     clear, itemized mismatch report (never silently proceeds on stale
//     assumptions).
//
// RESUMABILITY — same non-atomic-multi-key-write constraint admin-rename-
// account.js's own header comment documents at length (Netlify Blobs has no
// cross-key transaction primitive), so the writes below are ordered the
// same deliberate way: at every interruption point, the account stays fully
// resolvable and a retried call converges to the same correct end state.
//   1. Write the new u:ronbrightman record FIRST (email -> OWNER_EMAIL,
//      password -> probe's password). At this instant e:OWNER_EMAIL still
//      points at the probe username, so login-by-OWNER_EMAIL still resolves
//      via the untouched probe record — no lockout. A retry sees
//      u:ronbrightman's email already equal to OWNER_EMAIL and recognizes
//      this as ITS OWN prior partial write (status:'resumed'), not a
//      mismatch to refuse on.
//   2. Repoint e:OWNER_EMAIL -> "ronbrightman". From this instant on,
//      login-by-OWNER_EMAIL resolves the new username/password/(eventually)
//      balance. The probe's own u: record still exists and can still be
//      logged into directly by typing its literal username until step 4 —
//      a narrow, accepted window, same shape as admin-rename-account.js's
//      own resumable ordering already accepts.
//   3. Tombstone e:<dotted email> (only if it still points at
//      "ronbrightman" — defense-in-depth mirroring account-store.js's own
//      deleteAccount, never blindly deleting an index that might belong to
//      someone else). Drain the dotted email's entitlement balance into
//      OWNER_EMAIL's. Both idempotent — see their own functions' doc
//      comments for why a second run adds nothing extra.
//   4. Migrate feed ownerHandle entries (idempotent — a second run finds
//      nothing left tagged "@__probe_throwaway_user__").
//   5. Delete u:__probe_throwaway_user__ LAST — only once every other step
//      that depends on it (its password, its email match) has already
//      landed.
//
// Request: POST { usernameOrEmail, password, dryRun?, skipSnapshotSanityChecks? }
//   usernameOrEmail/password: real credentials, checked via
//     lib/account-store.js's verifyLogin — pass OWNER_EMAIL (or the probe's
//     literal username) plus the probe account's real password.
//   dryRun (optional boolean): performs the full auth + all read-side safety
//     checks and reports exactly what WOULD happen, with zero mutation.
//   skipSnapshotSanityChecks (optional boolean, default false): bypasses
//     ONLY the token-balance/dream-count mismatch checks (never the two
//     email-identity checks above) — see "SANITY CHECKS" above.
//
// Response: 200 { ok:true, dryRun, status, account?, tokens?, feed?,
//   tombstoned? }
//   status one of:
//     'consolidated'  — fresh consolidation performed (or would be, dryRun)
//     'resumed'       — a previous partial run's u:ronbrightman record was
//                        found already updated to OWNER_EMAIL, and the
//                        remaining steps were completed (or would be)
//     'already_done'  — the probe account is already gone and
//                        u:ronbrightman's email is already OWNER_EMAIL;
//                        the idempotent side steps (feed/token drain/index
//                        tombstone) still run, in case any of THOSE were
//                        left incomplete by an earlier interrupted call
//     'nothing_to_do' — neither the probe nor the ronbrightman account
//                        exists at all
//   account: { username, email } of the resulting/would-result account.
//   tokens: { ownerEmailBalanceBefore, oldEmailBalanceBefore,
//     newOwnerEmailBalance, oldEmailDrainedToZero }.
//   feed: { updatedCount, dreamIds } — probe dreams retagged.
//   tombstoned: { probeAccountDeleted, oldEmailIndexDeleted }.
// 409 refusals (ok:false):
//   E7: source_email_mismatch — the probe account's own on-file email is
//       NOT OWNER_EMAIL. Absolute, never skippable.
//   E8: ronbrightman_missing — u:ronbrightman doesn't exist at all, even
//       though the probe account does. This tool exists specifically to
//       resolve a CONFLICT between two existing accounts — if there's
//       nothing at "ronbrightman" to consolidate into, that's
//       admin-rename-account.js's job, not this one's.
//   E9: ronbrightman_email_mismatch — u:ronbrightman's own on-file email is
//       neither OWNER_EMAIL nor the expected dotted variant. Absolute,
//       never skippable — a genuinely unrelated third account somehow sits
//       on "ronbrightman"; refuse rather than guess.
//   E10: snapshot_mismatch — token balance / published-dream count for
//       either account doesn't match the diagnosed snapshot. Skippable via
//       `skipSnapshotSanityChecks:true` (see above). `details` on the
//       response body lists every mismatched field.
//   E11: ambiguous_partial_state — the probe account is already gone, but
//       u:ronbrightman's email is neither OWNER_EMAIL nor the dotted
//       variant. There is no safe way to auto-resolve this (the probe's
//       real password, needed to know what u:ronbrightman's password
//       "should" be, is gone) — refuse and report rather than guess.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as every sibling admin-*.js file in this codebase):
//   E1 method_not_allowed — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment
//   E3 invalid_json
//   E4 missing_fields — usernameOrEmail/password not both present
//   E5 forbidden — covers every credential-check failure
//   E6 rate_limited — too many attempts (per-IP or per-identifier) today
//   E7-E11 — see above

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var entitlements = require('./lib/entitlements');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var PROBE_USERNAME = accountStore.normalizeUsername('__probe_throwaway_user__');
var RON_USERNAME = accountStore.normalizeUsername('ronbrightman');
// The dotted-Gmail address confirmed (2026-07-28, tracker comment) to be
// the founder's own second real inbox — hardcoded, exactly like
// admin-rename-account.js's SOURCE_USERNAME/TARGET_USERNAME, since this is
// a one-off correction of one specific, already-diagnosed pair of
// accounts, not a general "reconcile any two emails" tool.
var EXPECTED_RONBRIGHTMAN_OLD_EMAIL = normalizeEmail('ronb.rightman@gmail.com');

// Diagnosed snapshot (tracker item
// for-product-rename-dry-run-refused-u-ron-rd0sm9, comment timestamped
// 2026-07-28T17:50:45.352Z) — see this file's own header comment's
// "SANITY CHECKS" section for why these are blocking by default but
// skippable via skipSnapshotSanityChecks.
var EXPECTED_PROBE_TOKEN_BALANCE = 1860;
var EXPECTED_PROBE_DREAM_IDS = ['dqocagbs', 'dm6bujus'];
var EXPECTED_RONBRIGHTMAN_TOKEN_BALANCE = 200;
var EXPECTED_RONBRIGHTMAN_DREAM_COUNT = 5;

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

function accountsStore() {
  return getStore({ name: accountStore.STORE_NAME });
}

/**
 * Real, server-verified credential check + owner-email confirmation.
 * Duplicated (deliberately — see header comment) from admin-rename-
 * account.js's own verifyOwnerCredentials.
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
 * Reads the shared feed-index once and returns a counter closure, same
 * shape as admin-diagnose-rename-conflict.js's own loadFeedCounter — kept
 * as a separate small duplicate here (rather than a shared import) for the
 * same "small self-contained check, not worth a cross-file coupling"
 * reasoning the header comment already applies to verifyOwnerCredentials.
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
 * Rewrites any dreamtube-feed feed-index entries whose ownerHandle is
 * "@__probe_throwaway_user__" to "@ronbrightman" — same approach as
 * admin-rename-account.js's own migrateFeedOwnerHandle. Idempotent — a run
 * that finds no matches makes no write at all. `dryRun` reports what WOULD
 * be rewritten without writing anything.
 */
async function migrateFeedOwnerHandle(event, dryRun) {
  connectLambda(event);
  var feedStore = getStore(FEED_STORE_NAME);
  var feed = (await feedStore.get(FEED_KEY, { type: 'json' })) || [];
  var sourceHandle = '@' + PROBE_USERNAME;
  var targetHandle = '@' + RON_USERNAME;

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
 * Removes the "e:<dotted email>" index, but ONLY if it currently resolves
 * to "ronbrightman" — same defense-in-depth account-store.js's own
 * deleteAccount already applies before removing an "e:" index (never
 * assume a key computation alone means it's safe to delete; confirm what
 * it actually points at first). Returns true if a tombstone-worthy index
 * was found (and, unless dryRun, removed); false if there was nothing
 * there, or it pointed somewhere else entirely (should never happen for
 * this specific, already-diagnosed pair, but refuse to touch it if it
 * ever did).
 */
async function tombstoneOldEmailIndex(event, dryRun) {
  connectLambda(event);
  var s = accountsStore();
  var key = 'e:' + EXPECTED_RONBRIGHTMAN_OLD_EMAIL;
  var currentTarget = await s.get(key, { type: 'json' });
  if (!currentTarget) return false;
  if (accountStore.normalizeUsername(currentTarget) !== RON_USERNAME) return false;
  if (!dryRun) await s.delete(key);
  return true;
}

/**
 * Sums BOTH entitlement balances (OWNER_EMAIL's and the dotted email's)
 * onto OWNER_EMAIL's record, and drains the dotted email's own balance to
 * exactly 0 — never deletes that record outright, since entitlements.js is
 * read purely by whatever email a caller supplies (generate-video.js/
 * create-checkout-session-dodo.js both accept a bare client-supplied email,
 * see client-trusted-email-at-generation-submi-vb2h3b/
 * client-trusted-email-at-checkout-now-ris-xxqf2s), independent of whether
 * any ACCOUNT still resolves to that email. A stray future request that
 * happens to submit the old dotted email directly must find a drained
 * (not phantom-fresh) balance — leaving `tokens` present-but-zeroed also
 * means syncTokens' own `!record.tokens` first-ever-read branch is never
 * re-triggered for it (which would otherwise silently re-materialize a
 * fresh 220-token INITIAL_GRANT the moment anything ever reads that email
 * again).
 *
 * Naturally idempotent on a retry: after the first successful drain, the
 * dotted email's own balance is 0, so a second run just adds 0 to
 * OWNER_EMAIL's balance and re-writes the same (already-zero) balance onto
 * the dotted record — no double-count, no marker field needed. Skips the
 * write entirely (even under a real, non-dryRun call) when there is
 * genuinely nothing to drain (oldBalance is already 0), so a harmless
 * re-run doesn't even bump `updatedAt` for no reason.
 */
async function drainDottedEmailIntoOwner(event, ownerEmail, dryRun) {
  var ownerRecord = await entitlements.getEntitlement(event, ownerEmail);
  var oldRecord = await entitlements.getEntitlement(event, EXPECTED_RONBRIGHTMAN_OLD_EMAIL);
  var ownerBalance = (ownerRecord && ownerRecord.tokens && typeof ownerRecord.tokens.balance === 'number') ? ownerRecord.tokens.balance : 0;
  var oldBalance = (oldRecord && oldRecord.tokens && typeof oldRecord.tokens.balance === 'number') ? oldRecord.tokens.balance : 0;
  var newOwnerBalance = ownerBalance + oldBalance;

  if (!dryRun && oldBalance !== 0) {
    await entitlements.setEntitlement(event, ownerEmail, {
      tokens: Object.assign({}, ownerRecord && ownerRecord.tokens, { balance: newOwnerBalance }),
      consolidatedFromEmail: EXPECTED_RONBRIGHTMAN_OLD_EMAIL,
      consolidatedTokensDrainedAt: Date.now(),
      consolidatedTokensDrainedAmount: oldBalance
    });
    await entitlements.setEntitlement(event, EXPECTED_RONBRIGHTMAN_OLD_EMAIL, {
      tokens: Object.assign({}, oldRecord && oldRecord.tokens, { balance: 0 })
    });
  }

  return {
    ownerEmailBalanceBefore: ownerBalance,
    oldEmailBalanceBefore: oldBalance,
    newOwnerEmailBalance: newOwnerBalance,
    oldEmailDrainedToZero: oldBalance !== 0
  };
}

/**
 * Compares live data against the diagnosed snapshot (see this file's own
 * header comment's "SANITY CHECKS" section) — only meaningful to call on a
 * FRESH (not-yet-run) consolidation, since a resumed/already-done run's
 * numbers have, by definition, already moved from the pre-run snapshot.
 * Returns an array of { field, expected, actual } mismatches — empty means
 * everything lines up.
 */
async function collectSnapshotMismatches(event, probeRecord, ronRecord) {
  var mismatches = [];
  var probeEntitlement = await entitlements.getEntitlement(event, probeRecord.email);
  var ronEntitlement = await entitlements.getEntitlement(event, ronRecord.email);
  var probeBalance = (probeEntitlement && probeEntitlement.tokens && probeEntitlement.tokens.balance) || 0;
  var ronBalance = (ronEntitlement && ronEntitlement.tokens && ronEntitlement.tokens.balance) || 0;

  var countFor = await loadFeedCounter(event);
  var probeCounted = countFor(PROBE_USERNAME);
  var ronCounted = countFor(RON_USERNAME);

  if (probeBalance !== EXPECTED_PROBE_TOKEN_BALANCE) {
    mismatches.push({ field: 'probeTokenBalance', expected: EXPECTED_PROBE_TOKEN_BALANCE, actual: probeBalance });
  }
  if (probeCounted.count !== EXPECTED_PROBE_DREAM_IDS.length) {
    mismatches.push({ field: 'probeDreamCount', expected: EXPECTED_PROBE_DREAM_IDS.length, actual: probeCounted.count });
  }
  var expectedProbeIdsSorted = EXPECTED_PROBE_DREAM_IDS.slice().sort();
  var actualProbeIdsSorted = probeCounted.ids.slice().sort();
  if (JSON.stringify(expectedProbeIdsSorted) !== JSON.stringify(actualProbeIdsSorted)) {
    mismatches.push({ field: 'probeDreamIds', expected: expectedProbeIdsSorted, actual: actualProbeIdsSorted });
  }
  if (ronBalance !== EXPECTED_RONBRIGHTMAN_TOKEN_BALANCE) {
    mismatches.push({ field: 'ronbrightmanTokenBalance', expected: EXPECTED_RONBRIGHTMAN_TOKEN_BALANCE, actual: ronBalance });
  }
  if (ronCounted.count !== EXPECTED_RONBRIGHTMAN_DREAM_COUNT) {
    mismatches.push({ field: 'ronbrightmanDreamCount', expected: EXPECTED_RONBRIGHTMAN_DREAM_COUNT, actual: ronCounted.count });
  }

  return mismatches;
}

/**
 * The actual consolidation decision + (unless dryRun) mutation. Returns
 * { httpStatus, body }. See header comment's RESUMABILITY section for the
 * write ordering this follows.
 */
async function performConsolidation(event, ownerEmail, dryRun, skipSnapshotSanityChecks) {
  connectLambda(event);
  var s = accountsStore();

  var probeRecord = await accountStore.getByUsername(event, PROBE_USERNAME);
  var ronRecord = await accountStore.getByUsername(event, RON_USERNAME);

  // ---- Nothing exists at all ----
  if (!probeRecord && !ronRecord) {
    return {
      httpStatus: 200,
      body: {
        ok: true, dryRun: !!dryRun, status: 'nothing_to_do', account: null, tokens: null,
        feed: { updatedCount: 0, dreamIds: [] },
        tombstoned: { probeAccountDeleted: false, oldEmailIndexDeleted: false }
      }
    };
  }

  // ---- Probe already gone ----
  if (!probeRecord) {
    var ronEmailIfProbeGone = normalizeEmail(ronRecord.email);
    if (ronEmailIfProbeGone === ownerEmail) {
      // Fully done already — still run the idempotent side steps in case
      // an earlier interrupted call left any of THEM incomplete.
      var feedAlready = await migrateFeedOwnerHandle(event, dryRun);
      var tokensAlready = await drainDottedEmailIntoOwner(event, ownerEmail, dryRun);
      var indexAlready = await tombstoneOldEmailIndex(event, dryRun);
      return {
        httpStatus: 200,
        body: {
          ok: true, dryRun: !!dryRun, status: 'already_done',
          account: { username: ronRecord.username, email: ronRecord.email },
          tokens: tokensAlready, feed: feedAlready,
          tombstoned: { probeAccountDeleted: true, oldEmailIndexDeleted: indexAlready }
        }
      };
    }
    // The probe account is gone, but u:ronbrightman's email is neither
    // OWNER_EMAIL nor the expected dotted variant. There's no safe way to
    // auto-resolve this (the probe's real password — needed to know what
    // this account's password "should" carry — no longer exists anywhere
    // this endpoint can read it from). Refuse and report rather than guess.
    return { httpStatus: 409, body: { ok: false, error: 'E11: ambiguous_partial_state' } };
  }

  // From here on, the probe account exists. The one check this whole file
  // exists to enforce first: never touch anything unless the probe
  // account's own on-file email really is the owner's.
  var probeEmail = normalizeEmail(probeRecord.email);
  if (probeEmail !== ownerEmail) {
    return { httpStatus: 409, body: { ok: false, error: 'E7: source_email_mismatch' } };
  }

  if (!ronRecord) {
    // This tool exists specifically to resolve a CONFLICT between two
    // existing accounts — if u:ronbrightman doesn't exist at all, there's
    // nothing to consolidate INTO (a plain rename is admin-rename-
    // account.js's job, not this one's).
    return { httpStatus: 409, body: { ok: false, error: 'E8: ronbrightman_missing' } };
  }

  var ronEmail = normalizeEmail(ronRecord.email);
  var isResumedMidRun = ronEmail === ownerEmail;
  var isFreshRun = ronEmail === EXPECTED_RONBRIGHTMAN_OLD_EMAIL;

  if (!isResumedMidRun && !isFreshRun) {
    return {
      httpStatus: 409,
      body: {
        ok: false, error: 'E9: ronbrightman_email_mismatch',
        details: { expectedOneOf: [ownerEmail, EXPECTED_RONBRIGHTMAN_OLD_EMAIL], actual: ronEmail }
      }
    };
  }

  if (isFreshRun && !skipSnapshotSanityChecks) {
    var mismatches = await collectSnapshotMismatches(event, probeRecord, ronRecord);
    if (mismatches.length) {
      return { httpStatus: 409, body: { ok: false, error: 'E10: snapshot_mismatch', details: mismatches } };
    }
  }

  var status = isResumedMidRun ? 'resumed' : 'consolidated';

  if (!dryRun && isFreshRun) {
    var newRonRecord = Object.assign({}, ronRecord, {
      email: ownerEmail,
      password: probeRecord.password,
      updatedAt: Date.now(),
      consolidatedFrom: PROBE_USERNAME,
      consolidatedAt: Date.now(),
      previousEmail: ronRecord.email
    });
    // Write ordering (see header comment): the updated target record
    // FIRST, so an interruption right after this line still leaves the
    // probe account fully intact and resolvable by email, with a retry
    // recognizing the new record as its own prior work (status:'resumed')
    // rather than a mismatch.
    await s.setJSON('u:' + RON_USERNAME, newRonRecord);
  }

  if (!dryRun) {
    // Repoint the OWNER_EMAIL index next — from this instant, login by
    // OWNER_EMAIL resolves the consolidated account.
    await s.setJSON('e:' + ownerEmail, RON_USERNAME);
  }

  var oldEmailIndexDeleted = await tombstoneOldEmailIndex(event, dryRun);
  var tokens = await drainDottedEmailIntoOwner(event, ownerEmail, dryRun);
  var feed = await migrateFeedOwnerHandle(event, dryRun);

  if (!dryRun) {
    // Delete the probe record LAST — only once every step that depended
    // on it (its password, its email match) has already landed.
    await s.delete('u:' + PROBE_USERNAME);
  }

  return {
    httpStatus: 200,
    body: {
      ok: true, dryRun: !!dryRun, status: status,
      account: { username: RON_USERNAME, email: ownerEmail },
      tokens: tokens, feed: feed,
      tombstoned: { probeAccountDeleted: true, oldEmailIndexDeleted: oldEmailIndexDeleted }
    }
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
  var dryRun = payload.dryRun === true;
  var skipSnapshotSanityChecks = payload.skipSnapshotSanityChecks === true;
  if (!usernameOrEmail || !password) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E4: missing_fields' }) };
  }

  // Same two-bucket (per-IP + per-identifier) rate limiting as
  // admin-rename-account.js/admin-diagnose-rename-conflict.js, and for the
  // identical reason: this performs a real password check against one
  // specific, high-value account.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 20;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_CONSOLIDATE_ACCOUNTS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 10;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-consolidate-accounts-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-consolidate-accounts-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var result = await performConsolidation(event, ownerEmail, dryRun, skipSnapshotSanityChecks);
  return { statusCode: result.httpStatus, body: JSON.stringify(result.body) };
};
