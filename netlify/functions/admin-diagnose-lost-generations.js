// netlify/functions/admin-diagnose-lost-generations.js
//
// READ-ONLY diagnostic for tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1 (P0: a real, token-
// charged generation — "Ziv is dancing" — completed (confirmed by a real
// PostHog video_created event) but its dream record was never found in
// the founder's account when checked from a fresh browser/device).
//
// Cross-references lib/job-owners.js's "who submitted this job" records
// (written at generation-SUBMISSION time, unconditionally, for every real
// generate-video.js/generate-image.js call — see that file's own header
// comment) against lib/dream-store.js's "who has a finished dream record"
// per-account store, matched by the SAME operationName
// (job-owners' own key == the dream's own `sourceOperationName`, stamped
// by js/store.js's finalizeDream at completion time). A job-owner record
// with no matching dream anywhere in that account's private-dream store
// is a genuine "charged, but the dream record itself never landed"
// candidate — exactly what this incident needs found, and exactly what
// Manager's own damage-count ask (any OTHER user since a given timestamp
// showing the same shape) needs swept for.
//
// WHAT THIS CANNOT TELL YOU: job-owners.js deliberately only ever records
// { email, mediaType, createdAt } (see that file's own header comment —
// "who submitted this job", nothing about WHAT was submitted). There is
// no server-side record of the original caption/style for a normal
// signed-in generation (video-status.js's own live-completion path is
// what a real signed-in user's generation always goes through — contrast
// the pre-signup funnel's lib/pending-dreams.js, which DOES carry
// caption/style, but is a fully separate, already-covered path with its
// own claimed/notified lifecycle, not what this incident is about). A
// "lost" verdict here proves tokens were charged and a real generation
// completed with no surviving dream record; it does NOT by itself recover
// the original caption/style — only whatever fal.ai still has for the raw
// media (see admin-repair-lost-generations.js's own header comment for
// the recovery tool this diagnostic feeds, and its explicit
// captionOverride/styleOverride params for exactly this gap).
//
// Also does NOT cross-reference the shared PUBLISHED feed — publish-
// dream.js's own request body never carries sourceOperationName at all
// (dream-sync.js's private-store field whitelist is the only place that
// field survives a round trip — see that file's own DREAM_FIELDS), so a
// dream that was published (then possibly unpublished) has no reliable
// operationName to match back against here. Not expected to matter for
// this incident (the founder's own report was about a PRIVATE, unpublished
// dream), flagged here so a caller doesn't over-read a "lost" verdict as
// proof the content is unrecoverable from a published copy too — check the
// shared feed by caption/timing separately if that's ever relevant.
//
// TWO MODES:
//   mode: 'account' — given `targetUsername` (start with the founder's own
//     account, `ronbrightman`, per this incident), resolves that account's
//     email, then pages over the job-owners store (see SCAN below)
//     collecting every record whose email matches, cross-referenced
//     against that account's own dream-store sourceOperationName set.
//   mode: 'sweep' — pages over EVERY job-owner record created at or after
//     `sinceTimestamp`, resolves each one's owning account (reverse email
//     lookup), and tallies affected-account/lost-job counts across the
//     WHOLE app — Manager's own "count the damage" ask. Report-only, never
//     writes or repairs anything (see admin-repair-lost-generations.js).
//
// SCAN: lib/job-owners.js has no secondary index by account or by date
// (see that file's own header comment — it's a plain jobId -> record map)
// — there is no way to ask it "every job for account X" or "every job
// since yesterday" directly. This pages over its FULL key list
// (offset/limit, same shape admin-repair-oversized-media.js's own account
// pagination uses) and reads + filters each record in that page. A store
// with a lot of history will need several successive calls
// (`cursor`/`nextCursor`, same contract as every sibling paginated admin
// tool) — accepted for an app at this scale (see FOUNDER_PRINCIPLES.md's
// "very few users so far") and consistent with this codebase's existing
// full-sweep admin tools (admin-repair-oversized-media.js sweeps every
// account's private-dreams store the exact same way).
//
// AUTH: identical bar to every sibling admin diagnostic — real,
// server-verified password (lib/account-store.js's verifyLogin) against
// an account whose own on-file email matches OWNER_EMAIL. Duplicated
// inline rather than shared, matching this codebase's explicit precedent
// (see admin-diagnose-account-duplicates.js's own header comment).
//
// Request: POST { usernameOrEmail, password, mode, targetUsername?,
//   sinceTimestamp?, cursor?, limit? }
//   mode: 'account' requires targetUsername.
//   mode: 'sweep' requires a valid sinceTimestamp (epoch ms) — refuses an
//   unbounded all-time sweep by design (this tool exists for a time-boxed
//   incident, not a standing full-history report).
// Response (mode: 'account'): 200 { ok:true, mode, targetUsername, email,
//   jobs: [ { operationName, mediaType, createdAt, hasDream, dreamId } ],
//   scannedJobOwnerKeys, totalJobOwnerKeys, nextCursor, done }
// Response (mode: 'sweep'): 200 { ok:true, mode, sinceTimestamp,
//   scannedJobOwnerKeys, totalJobOwnerKeys, jobsInWindow, lostJobs,
//   accountsAffected, accountsUnresolved, details, nextCursor, done }
//   accountsUnresolved: job-owner records in the window whose email could
//   not be resolved back to any known account (e.g. the account was since
//   deleted, or the email was never a real account at all) — reported
//   separately, never silently folded into accountsAffected/lostJobs.
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 invalid_mode — mode isn't 'account' or 'sweep'
//   E8 missing_target_username — mode:'account' with no targetUsername
//   E9 missing_since_timestamp — mode:'sweep' with no valid sinceTimestamp
//   E10 invalid_limit

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var jobOwners = require('./lib/job-owners');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var PAGE_SIZE_DEFAULT = 100;
var MAX_LIMIT = 500;
var MAX_DETAIL_ENTRIES = 200;

/** Real, server-verified credential check + owner-email confirmation — duplicated from admin-diagnose-account-duplicates.js's own copy, see header comment. */
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

/** Reads one page of RAW job-owner records (operationName + record), offset/limit over the store's full key list — see this file's own SCAN header comment. */
async function scanJobOwnersPage(event, offset, limit) {
  connectLambda(event);
  var store = getStore({ name: jobOwners.STORE_NAME });
  var listResult = await store.list();
  var keys = listResult.blobs.map(function (b) { return b.key; });
  var page = keys.slice(offset, offset + limit);

  var records = [];
  for (var i = 0; i < page.length; i++) {
    var record = await jobOwners.getJobOwnerRecord(event, page[i]);
    if (record) records.push({ operationName: page[i], record: record });
  }

  var nextOffset = (offset + limit) < keys.length ? (offset + limit) : null;
  return { records: records, totalKeys: keys.length, nextOffset: nextOffset };
}

async function runAccountMode(event, targetUsername, offset, limit) {
  var account = await accountStore.getByUsername(event, targetUsername);
  if (!account) return { notFound: true };
  var email = normalizeEmail(account.email);

  var dreams = await dreamStore.getPrivateDreams(event, targetUsername);
  var dreamByOp = {};
  dreams.forEach(function (d) {
    if (d.sourceOperationName) dreamByOp[d.sourceOperationName] = d.id;
  });

  var page = await scanJobOwnersPage(event, offset, limit);
  var jobs = [];
  page.records.forEach(function (entry) {
    if (normalizeEmail(entry.record.email) !== email) return;
    var dreamId = dreamByOp[entry.operationName] || null;
    jobs.push({
      operationName: entry.operationName,
      mediaType: entry.record.mediaType || 'unknown',
      createdAt: entry.record.createdAt || null,
      hasDream: !!dreamId,
      dreamId: dreamId
    });
  });

  return {
    notFound: false, email: account.email,
    jobs: jobs, scannedJobOwnerKeys: page.records.length + (offset), totalJobOwnerKeys: page.totalKeys,
    nextCursor: page.nextOffset === null ? null : String(page.nextOffset)
  };
}

async function runSweepMode(event, sinceTimestamp, offset, limit) {
  var page = await scanJobOwnersPage(event, offset, limit);

  var jobsInWindow = 0;
  var lostJobs = 0;
  var accountsAffectedSet = {};
  var accountsUnresolvedSet = {};
  var details = [];
  // Cache per-call — several jobs in the same page commonly belong to the
  // same account; avoids re-fetching that account's dream list once per job.
  var dreamOpCache = {};
  var accountCache = {};

  for (var i = 0; i < page.records.length; i++) {
    var entry = page.records[i];
    var createdAt = entry.record.createdAt || 0;
    if (createdAt < sinceTimestamp) continue;
    jobsInWindow++;

    var email = normalizeEmail(entry.record.email);
    if (!(email in accountCache)) {
      accountCache[email] = await accountStore.getByEmail(event, email);
    }
    var account = accountCache[email];
    if (!account) {
      accountsUnresolvedSet[email] = true;
      if (details.length < MAX_DETAIL_ENTRIES) {
        details.push({ operationName: entry.operationName, email: email, createdAt: createdAt, mediaType: entry.record.mediaType || 'unknown', accountResolved: false, hasDream: null });
      }
      continue;
    }

    var username = account.username;
    if (!(username in dreamOpCache)) {
      var dreams = await dreamStore.getPrivateDreams(event, username);
      var opSet = {};
      dreams.forEach(function (d) { if (d.sourceOperationName) opSet[d.sourceOperationName] = d.id; });
      dreamOpCache[username] = opSet;
    }
    var dreamId = dreamOpCache[username][entry.operationName] || null;
    var hasDream = !!dreamId;
    if (!hasDream) {
      lostJobs++;
      accountsAffectedSet[username] = true;
    }
    if (details.length < MAX_DETAIL_ENTRIES) {
      details.push({
        operationName: entry.operationName, email: email, username: username,
        createdAt: createdAt, mediaType: entry.record.mediaType || 'unknown',
        accountResolved: true, hasDream: hasDream, dreamId: dreamId
      });
    }
  }

  return {
    jobsInWindow: jobsInWindow, lostJobs: lostJobs,
    accountsAffected: Object.keys(accountsAffectedSet).length,
    accountsUnresolved: Object.keys(accountsUnresolvedSet).length,
    details: details,
    scannedJobOwnerKeys: page.records.length + offset, totalJobOwnerKeys: page.totalKeys,
    nextCursor: page.nextOffset === null ? null : String(page.nextOffset)
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

  var mode = payload.mode;
  if (mode !== 'account' && mode !== 'sweep') {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: invalid_mode' }) };
  }

  var targetUsername = typeof payload.targetUsername === 'string' ? payload.targetUsername.trim() : '';
  if (mode === 'account' && !targetUsername) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E8: missing_target_username' }) };
  }

  var sinceTimestamp = Number(payload.sinceTimestamp);
  if (mode === 'sweep' && !(Number.isFinite(sinceTimestamp) && sinceTimestamp > 0)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E9: missing_since_timestamp' }) };
  }

  var limit = PAGE_SIZE_DEFAULT;
  if (payload.limit !== undefined) {
    var parsedLimit = parseInt(payload.limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_LIMIT) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E10: invalid_limit' }) };
    }
    limit = parsedLimit;
  }

  var offset = 0;
  if (payload.cursor !== undefined && payload.cursor !== null && payload.cursor !== '') {
    var parsedCursor = parseInt(payload.cursor, 10);
    if (Number.isInteger(parsedCursor) && parsedCursor >= 0) offset = parsedCursor;
  }

  // Same two-bucket rate limiting as every sibling admin tool.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_LOST_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 500;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_DIAGNOSE_LOST_GENERATIONS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 500;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-lost-generations-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-diagnose-lost-generations-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  try {
    if (mode === 'account') {
      var result = await runAccountMode(event, targetUsername, offset, limit);
      if (result.notFound) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'account', targetUsername: targetUsername, found: false, jobs: [], done: true }) };
      }
      return {
        statusCode: 200,
        body: JSON.stringify(Object.assign({ ok: true, mode: 'account', targetUsername: targetUsername, found: true, done: result.nextCursor === null }, result))
      };
    }

    var swept = await runSweepMode(event, sinceTimestamp, offset, limit);
    return {
      statusCode: 200,
      body: JSON.stringify(Object.assign({ ok: true, mode: 'sweep', sinceTimestamp: sinceTimestamp, done: swept.nextCursor === null }, swept))
    };
  } catch (e) {
    console.error('admin-diagnose-lost-generations: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'diagnose_failed: ' + (e && e.message) }) };
  }
};
