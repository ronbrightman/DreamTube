// netlify/functions/admin-repair-lost-generations.js
//
// Owner-only, real-password-gated REPAIR for tracker item
// for-product-p0-data-loss-founder-repro-0-6bzvv1 (P0: a real, token-
// charged generation — "Ziv is dancing" — completed but its dream record
// never landed anywhere the founder could find it). Companion to
// admin-diagnose-lost-generations.js, which FINDS a "charged, but no
// surviving dream record" candidate by cross-referencing lib/job-owners.js
// against lib/dream-store.js — this file attempts to actually RESTORE one,
// given its operationName and owning account.
//
// RECOVERY PATH: parses `operationName`'s "fal:<model>:<request_id>" shape
// (same convention admin-repair-oversized-media.js's own
// parseSourceOperationName already established — duplicated here rather
// than shared, matching that file's own "each admin tool self-contained"
// precedent), re-queries fal's own result endpoint fresh (same
// status-then-result two-call sequence as video-status.js's
// checkFalStatus / admin-repair-oversized-media.js's fetchFreshFalUrl —
// duplicated for the same reason), and if fal still has the result
// (~7-day retention window per this codebase's own documented fal-media-
// expiry concern — see docs referenced from tracker item
// for-product-urgent-founder-family-repro--nsbbg5), re-hosts it durably
// via lib/media-rehost.js's rehostBestEffort (the SAME function/key
// convention the live completion path uses — requestId as the Blobs key
// — so a future admin-repair-oversized-media.js sweep finds this record
// exactly like any other), then constructs and WRITES a real dream record
// into the target account's private-dream store via
// lib/dream-store.js's upsertPrivateDream. This genuinely restores the
// dream — it is not a report-only tool.
//
// WHAT CANNOT BE RECOVERED: job-owners.js never records the original
// caption/style (see admin-diagnose-lost-generations.js's own header
// comment for why) — there is no server-side source for it. The recovered
// record's caption defaults to a clearly-labeled placeholder
// ("Recovered generation — original description was not stored
// server-side") unless the caller supplies `captionOverride`/
// `styleOverride` explicitly — a human who already knows what the video
// was about (as Ron does for "Ziv is dancing," from his own report)
// should pass those. `recoveredAt`/`recoveredVia` are stamped on the
// written record so it's always honestly distinguishable from an
// ordinarily-generated dream, both in future diagnostics and for anyone
// looking directly at the data later.
//
// IDEMPOTENT / SAFE TO RE-RUN: before writing anything, re-checks the
// target account's CURRENT dream-store for a dream already carrying this
// operationName (the same race admin-diagnose-lost-generations.js's own
// mode:'account' surfaces as `hasDream`, but re-checked fresh here rather
// than trusting a caller's possibly-stale diagnostic read) — refuses to
// write a duplicate if one already exists (`E11: already_recovered`),
// rather than silently creating a second dream for the same completed
// generation.
//
// DRY RUN (`dryRun`, optional): performs the fal status/result lookup
// (read-only, no Blobs write, no dream-store write) and reports exactly
// what a real run would do — `wouldRecover: true` with the media type/url
// it found, or a `failed`-shaped reason — without spending a re-host or
// touching any stored data. Lets a human preview + confirm before this
// spends anything.
//
// AUTH: identical bar to admin-repair-oversized-media.js — real,
// server-verified password (lib/account-store.js's verifyLogin) against
// an account whose own on-file email matches OWNER_EMAIL. This tool both
// writes real user dream data AND (in its real-repair path) calls a paid
// external API, so it needs the same strong bar that tool uses.
// Duplicated inline rather than shared, matching this codebase's explicit
// precedent (see admin-diagnose-account-duplicates.js's own header
// comment).
//
// Request: POST { usernameOrEmail, password, targetUsername, operationName,
//   captionOverride?, styleOverride?, dryRun? }
// Response: 200 { ok:true, dryRun, outcome, dreamId?, mediaType?, url?,
//   reason?, captionUsed? }
//   outcome: 'recovered' | 'would_recover' | 'already_recovered' |
//     'no_job_owner_record' | 'account_mismatch' | 'failed'
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 missing_target_username
//   E8 missing_operation_name
//   E9 target_account_not_found
//   E10 invalid_operation_name — doesn't match the "fal:<model>:<request_id>" shape
//   E11 already_recovered — the target account already has a dream carrying this operationName

var { connectLambda } = require('@netlify/blobs');
var crypto = require('crypto');
var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var jobOwners = require('./lib/job-owners');
var mediaRehost = require('./lib/media-rehost');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');

var FAL_API_BASE = 'https://queue.fal.run';
var PLACEHOLDER_CAPTION = 'Recovered generation — original description was not stored server-side';

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

/** Parses "fal:<model>:<request_id>" — duplicated from admin-repair-oversized-media.js's own parseSourceOperationName, see that file's header comment on why each admin tool keeps its own copy. */
function parseOperationName(operationName) {
  var parts = typeof operationName === 'string' ? operationName.split(':') : [];
  if (parts.length !== 3 || parts[0] !== 'fal' || !parts[1] || !parts[2]) return null;
  return { model: parts[1], requestId: parts[2] };
}

function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

function parseJsonSafe(res) {
  return res.text().then(function (text) {
    try {
      return { ok: true, data: text ? JSON.parse(text) : {} };
    } catch (e) {
      return { ok: false, rawText: text };
    }
  });
}

/**
 * Re-queries fal fresh and returns { ok:true, url } or { ok:false, reason }
 * — duplicated from admin-repair-oversized-media.js's own
 * fetchFreshFalUrl (see that file's header comment), extended with
 * `mediaType` inference: job-owners.js's own record may say 'unknown' (a
 * record predating that field), so this tries video first, then image,
 * rather than assuming.
 */
async function fetchFreshFalResult(mediaType, model, requestId, falKey) {
  try {
    var appBase = falAppBase(model);
    var statusRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId + '/status', {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    if (statusRes.status === 404) return { ok: false, reason: 'fal_result_gone' };
    var parsedStatus = await parseJsonSafe(statusRes);
    if (!statusRes.ok || !parsedStatus.ok) return { ok: false, reason: 'fal_status_check_failed' };
    if (parsedStatus.data.status !== 'COMPLETED') return { ok: false, reason: 'fal_result_gone' };

    var resultRes = await fetch(FAL_API_BASE + '/' + appBase + '/requests/' + requestId, {
      headers: { 'Authorization': 'Key ' + falKey }
    });
    if (resultRes.status === 404) return { ok: false, reason: 'fal_result_gone' };
    var parsedResult = await parseJsonSafe(resultRes);
    if (!resultRes.ok || !parsedResult.ok) return { ok: false, reason: 'fal_result_fetch_failed' };

    var videoUrl = parsedResult.data.video && parsedResult.data.video.url;
    var imageUrl = parsedResult.data.images && parsedResult.data.images[0] && parsedResult.data.images[0].url;

    if (mediaType === 'video' && videoUrl) return { ok: true, mediaType: 'video', url: videoUrl };
    if (mediaType === 'image' && imageUrl) return { ok: true, mediaType: 'image', url: imageUrl };
    // mediaType unknown (a job-owner record predating that field) -- infer
    // from whichever shape fal's own result actually carries.
    if (videoUrl) return { ok: true, mediaType: 'video', url: videoUrl };
    if (imageUrl) return { ok: true, mediaType: 'image', url: imageUrl };
    return { ok: false, reason: 'fal_result_missing_media' };
  } catch (e) {
    return { ok: false, reason: 'fal_fetch_error' };
  }
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

  var targetUsername = typeof payload.targetUsername === 'string' ? payload.targetUsername.trim() : '';
  if (!targetUsername) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: missing_target_username' }) };
  }

  var operationName = typeof payload.operationName === 'string' ? payload.operationName.trim() : '';
  if (!operationName) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E8: missing_operation_name' }) };
  }

  var dryRun = payload.dryRun === true;
  var captionOverride = typeof payload.captionOverride === 'string' && payload.captionOverride.trim() ? payload.captionOverride.trim() : null;
  var styleOverride = typeof payload.styleOverride === 'string' && payload.styleOverride.trim() ? payload.styleOverride.trim() : null;

  // Same two-bucket rate limiting as every sibling admin tool. Deliberately
  // low ceilings — this is a rare, deliberate, one-record-at-a-time repair
  // action, not a bulk sweep (contrast admin-repair-oversized-media.js's
  // generous per-day ceiling for its own paginated sweep).
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_LOST_GENERATIONS_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 50;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_LOST_GENERATIONS_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 50;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-lost-generations-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-lost-generations-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  try {
    var targetAccount = await accountStore.getByUsername(event, targetUsername);
    if (!targetAccount) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E9: target_account_not_found' }) };
    }

    var op = parseOperationName(operationName);
    if (!op) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E10: invalid_operation_name' }) };
    }

    var jobOwnerRecord = await jobOwners.getJobOwnerRecordWithRetry(event, operationName);
    if (!jobOwnerRecord) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: dryRun, outcome: 'no_job_owner_record' }) };
    }
    if (normalizeEmail(jobOwnerRecord.email) !== normalizeEmail(targetAccount.email)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: dryRun, outcome: 'account_mismatch' }) };
    }

    // Re-checked fresh, not trusted from a caller's possibly-stale
    // diagnostic read — see this file's own IDEMPOTENT header comment.
    var existingDreams = await dreamStore.getPrivateDreams(event, targetUsername);
    var already = existingDreams.find(function (d) { return d.sourceOperationName === operationName; });
    if (already) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: dryRun, outcome: 'already_recovered', dreamId: already.id }) };
    }

    var falKey = process.env.FAL_KEY || null;
    if (!falKey) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: dryRun, outcome: 'failed', reason: 'missing_fal_key' }) };
    }

    var fresh = await fetchFreshFalResult(jobOwnerRecord.mediaType || 'unknown', op.model, op.requestId, falKey);
    if (!fresh.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: dryRun, outcome: 'failed', reason: fresh.reason }) };
    }

    var captionUsed = captionOverride || PLACEHOLDER_CAPTION;
    var styleUsed = styleOverride || null;

    if (dryRun) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, dryRun: true, outcome: 'would_recover', mediaType: fresh.mediaType, url: fresh.url, captionUsed: captionUsed, styleUsed: styleUsed })
      };
    }

    connectLambda(event);
    var rehost = await mediaRehost.rehostBestEffort(event, fresh.mediaType, fresh.url, op.requestId);
    // rehostBestEffort's own `tooLargeToServe` case still durably stored
    // the bytes (see that function's own header comment) but keeps fal's
    // own url as the servable one -- either way there IS a usable url to
    // write onto the recovered dream record.
    var durableOrFalUrl = (rehost.ok && rehost.url) ? rehost.url : fresh.url;

    var newDreamId = 'drecovered' + crypto.randomBytes(6).toString('hex');
    var now = Date.now();
    var dream = {
      id: newDreamId,
      ownerHandle: '@' + targetUsername,
      caption: captionUsed, promptText: null, storyText: captionUsed,
      style: styleUsed, mediaType: fresh.mediaType,
      likes: 0, likedByMe: false, isPublished: false,
      videoUrl: fresh.mediaType === 'video' ? durableOrFalUrl : null,
      imageUrl: fresh.mediaType === 'image' ? durableOrFalUrl : null,
      sourceOperationName: operationName,
      createdAt: jobOwnerRecord.createdAt || now,
      updatedAt: now,
      // Honest provenance markers -- see this file's own header comment.
      recoveredAt: now,
      recoveredVia: 'admin-repair-lost-generations'
    };
    if (fresh.mediaType === 'video') dream.dur = '0:08';

    var writeResult = await dreamStore.upsertPrivateDream(event, targetUsername, dream);
    if (!writeResult.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: false, outcome: 'failed', reason: 'dream_store_write_failed' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, dryRun: false, outcome: 'recovered', dreamId: newDreamId, mediaType: fresh.mediaType, url: durableOrFalUrl, captionUsed: captionUsed, styleUsed: styleUsed })
    };
  } catch (e) {
    console.error('admin-repair-lost-generations: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'repair_failed: ' + (e && e.message) }) };
  }
};
