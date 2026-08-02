// netlify/functions/admin-repair-oversized-media.js
//
// Owner-only, real-password-gated REPAIR sweep — tracker item
// for-product-urgent-reopen-video-repair-p-cyp8np, reopening
// for-product-urgent-founder-repro-on-drea-uq3a36 after Manager
// live-verified (curl) that at least one specific founder dream (key
// 019fc2e9-2f8d-7dc0-8ce7-7efd3acf0d2f) still 502s even AFTER that item's
// own fix shipped.
//
// WHY THE ORIGINAL FIX DOESN'T COVER THIS: lib/media-rehost.js's SIZE fix
// (see that file's own "SIZE — CORRECTED 2026-08-02" header comment) only
// changed what gets written on a NEW re-host — going forward, every record
// carries `metadata.byteLength` (and `metadata.sourceUrl` when oversized),
// so video-file.mjs/image-file.mjs's defensive redirect has something to
// redirect TO. A record re-hosted BEFORE that fix shipped was written with
// `git show 3958ee9:netlify/functions/lib/media-rehost.js`'s original
// `store.set(key, arrayBuffer, { metadata: { contentType: contentType } })`
// — no sourceUrl, no byteLength, ever. For a record like that whose
// underlying blob genuinely IS oversized, video-file.mjs's own defensive
// check (`typeof metadata.byteLength === 'number' && ... > MAX && ...
// sourceUrl`) can never fire — `byteLength` isn't a number at all, it's
// `undefined` — so it falls through to streaming the full oversized body
// and 502s exactly as it did before the fix, forever, until something
// backfills real metadata onto that specific key.
//
// TWO-TIER REPAIR (this sweep's whole point — see this task's own SCOPE
// section): calling fal for every legacy `{contentType}`-only record would
// blindly spend real fal API reads on records that are almost certainly
// already fine (oversized-and-broken was always a minority case, even
// before the SIZE fix existed — most legacy media is well under 18MB).
// So for every candidate (a durable video-file/image-file url whose
// current Blobs metadata has no byteLength at all):
//   1. Measure the REAL current size of what's already durably stored —
//      store.get(key, {type:'arrayBuffer'}).byteLength — a plain Blobs
//      read, no fal call, no cost. This alone tells us if the record is
//      actually broken or just missing metadata for no-longer-relevant
//      reasons.
//   2. If that measured size is <= MAX_STREAMABLE_BYTES, the record was
//      NEVER actually broken (video-file.mjs already streams it fine
//      regardless of missing byteLength metadata — that field is only
//      READ by the oversized-redirect branch). Backfill byteLength onto
//      the existing metadata so a future sweep doesn't re-measure it, and
//      move on — no fal call, no re-download, negligible cost.
//   3. Only if that measured size is ACTUALLY > MAX_STREAMABLE_BYTES does
//      this sweep spend a real fal call: re-query fal fresh
//      (`sourceOperationName`'s "fal:<model>:<request_id>" shape — see
//      video-status.js's checkFalStatus / image-status.js's
//      checkFalImageStatus for the exact request/result endpoints this
//      mirrors) and re-run the fresh url through lib/media-rehost.js's
//      NOW-FIXED rehostBestEffort with `{ force: true }` (see that
//      function's own header comment on why `force` exists and who it's
//      for) — same Blobs key, so this legitimately overwrites the broken
//      metadata-less entry in place with one carrying real
//      sourceUrl+byteLength, exactly like a first-time re-host would have
//      produced had it run after the fix instead of before it.
//
// A generation can genuinely be gone from fal's side by the time this
// sweep runs (fal's own result retention is not infinite either) — that is
// a real, expected outcome for a record this old, not a hypothetical or a
// crash: reported per-item as `failed` with reason `fal_result_gone`,
// never thrown. Every other network/shape failure against fal is reported
// the same way, never lets one broken record abort the whole sweep (same
// posture as admin-backfill-media-rehost.js's own per-record error
// handling — this file mirrors that tool's overall shape closely).
//
// WHAT THIS DOES *NOT* TOUCH: a dream/feed record's own videoUrl/imageUrl
// field never changes here — it's already the correct
// `/.netlify/functions/video-file?key=...` (or image-file) url in every
// case this sweep handles; only what's BEHIND that key in Blobs
// (metadata, and for the fal-repair tier, the stored bytes themselves)
// gets rewritten. Contrast admin-backfill-media-rehost.js, which DOES
// rewrite a record's url field, because its job is turning a still-on-fal
// url into a durable one in the first place — a different problem this
// sweep never needs to solve (see SCOPE above: only ALREADY-durable urls
// with missing byteLength are candidates here).
//
// SCOPE: sweeps the same two real stores admin-backfill-media-rehost.js
// does — lib/dream-store.js's "dreamtube-private-dreams" (enumerated via
// its own list()) and the shared published feed ("dreamtube-feed") — with
// the same offset/'feed' cursor pagination shape, for the same "a Netlify
// Function has a real execution-time ceiling" reason. See that file's own
// header comment for the full pagination/idempotency reasoning, which
// applies identically here.
//
// TARGETING (`targetDreamIds` and/or `targetKeys`, both optional): restrict
// this sweep to exactly the named records. This tool is deliberately still
// a general sweep, not hardcoded to any specific record, but the founder's
// own DONE bar for this task names exact dreams/keys to verify against —
// these let a caller point the sweep at exactly those without waiting
// on/paying for a full account-by-account scan of every other unrelated
// record. Every OTHER record is still scanned past (cheaply — a plain
// string compare) but never acted on when either filter is set. Two
// SEPARATE identifier spaces exist here, so two separate filters:
//   - `targetDreamIds` matches a dream/feed record's own `id` field —
//     client-minted by js/store.js's newId() as "d" + 7 random base36
//     chars (e.g. "d49us2fm"). Checked once per RECORD, before either of
//     its media fields is even looked at.
//   - `targetKeys` matches the actual Blobs key a specific media field
//     resolves to (the `key=` query param on its durable video-file/
//     image-file url — see extractKeyFromDurableUrl) — this is the fal
//     requestId for anything hosted via the live completion path
//     (video-status.js/image-status.js/dream-webhook.js), a real UUID-
//     shaped string, NOT the same shape as a dream id. Checked once per
//     FIELD, since one record's video and image keys can independently
//     match or not.
// A caller chasing one specific known-broken record by its Blobs key
// (rather than by the dream it belongs to) uses `targetKeys`; chasing one
// by its dream id uses `targetDreamIds`. Both may be set together (a
// record must pass targetDreamIds AND, per field, targetKeys), but
// ordinarily only one is used per call.
//
// DRY RUN (`dryRun`, optional): when true, performs every read needed to
// classify each candidate (including the local Blobs byte-length
// measurement — cheap, no fal call) but makes NO writes and calls fal for
// NOTHING — every candidate that would need the real repair tier is
// reported as `would_repair_via_fal` (with the same-shape failure reason
// surfaced up front, e.g. `missing_or_invalid_source_operation_name`, if
// that's already knowable without ever calling fal) instead of actually
// being repaired. Lets a human preview exactly what a real run would do
// and spend before authorizing it to actually spend anything.
//
// AUTH: identical bar to admin-backfill-media-rehost.js/
// admin-media-library-data.js — real, server-verified password
// (lib/account-store.js's verifyLogin) against an account whose own
// on-file email matches OWNER_EMAIL. This tool both reads real user dream
// data AND (in its real-repair tier) calls a paid external API, so it
// needs the same strong bar those two tools use — never the weaker
// email-only bar owner-topup-tokens.js uses for a lower-stakes action.
// Duplicated inline rather than shared, matching this codebase's explicit
// precedent (see admin-diagnose-account-duplicates.js's own header
// comment).
//
// Request: POST { usernameOrEmail, password, cursor?, limit?, dryRun?,
//   targetDreamIds?, targetKeys? }
// Response: 200 { ok:true, phase, scannedAccounts, scannedMediaItems,
//   alreadyFixed, backfilledMetadataOnly, repairedViaFal, failed,
//   skippedNoDurableMedia, blobMissing, details, nextCursor, done }
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited
//   E7 invalid_limit — `limit` present but not a positive integer <= MAX_LIMIT

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');
var mediaStatus = require('./lib/media-status');
var mediaRehost = require('./lib/media-rehost');

var ACCOUNTS_PER_CALL_DEFAULT = 25;
var MAX_LIMIT = 200;
var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';
var FAL_API_BASE = 'https://queue.fal.run';

// Bounded so a large sweep's response body can't grow unboundedly — the
// counts (alreadyFixed/backfilledMetadataOnly/repairedViaFal/failed/...)
// are always exact regardless of this cap; only the per-item `details`
// array (the specific dreamId/key/outcome list, useful for verifying
// exactly which records were touched) is truncated past this many entries.
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

/** Extracts the `key` query param out of a durable video-file/image-file url (see lib/media-rehost.js's durableUrl) — the ACTUAL Blobs key this record's media lives under, whatever convention produced it (the live completion path keys by fal requestId; admin-backfill-media-rehost.js's own sweep keys by `id:mediaType` instead — reading the key back out of the record's own url sidesteps needing to know or guess which one applies to any given record). */
function extractKeyFromDurableUrl(url) {
  var qIndex = typeof url === 'string' ? url.indexOf('?') : -1;
  if (qIndex === -1) return null;
  var params = new URLSearchParams(url.slice(qIndex));
  var key = params.get('key');
  return key || null;
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

// fal's queue status/result endpoints route on just the app's
// "owner/alias", not the full model id — duplicated from
// video-status.js's own falAppBase, same "each function self-contained"
// convention (see that file's own header comment on humanizeFalDetail).
function falAppBase(model) {
  var parts = model.split('/');
  return parts[0] + '/' + parts[1];
}

/**
 * Re-queries fal fresh for `requestId` (of app `model`) and returns
 * { ok: true, url } with the current media url fal is serving, or
 * { ok: false, reason } for any failure — including the real, expected
 * "fal no longer has this result" outcome (a 404 on either call, or a
 * status that isn't COMPLETED — the original generation may simply have
 * expired/been deleted on fal's own side by now). NEVER throws.
 */
async function fetchFreshFalUrl(mediaType, model, requestId, falKey) {
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

    var url = mediaType === 'image'
      ? (parsedResult.data.images && parsedResult.data.images[0] && parsedResult.data.images[0].url)
      : (parsedResult.data.video && parsedResult.data.video.url);
    if (!url) return { ok: false, reason: 'fal_result_missing_media' };
    return { ok: true, url: url };
  } catch (e) {
    return { ok: false, reason: 'fal_fetch_error' };
  }
}

/** Parses a dream/feed record's sourceOperationName ("fal:<model>:<request_id>", see dream-sync.js's own DREAM_FIELDS / js/store.js's finalizeDream) into { model, requestId }, or null if missing/malformed. */
function parseSourceOperationName(record) {
  var opName = typeof record.sourceOperationName === 'string' ? record.sourceOperationName : '';
  var parts = opName.split(':');
  if (parts.length !== 3 || parts[0] !== 'fal' || !parts[1] || !parts[2]) return null;
  return { model: parts[1], requestId: parts[2] };
}

/**
 * Classifies + (unless dryRun) repairs ONE media field (videoUrl or
 * imageUrl) already on `record`. Returns { outcome, key, ... } — never
 * throws. `outcome` is one of: null (no durable media on this field at
 * all, not a candidate), 'blob_missing' (durable url but nothing actually
 * stored under that key — can't measure, can't repair, worth a human
 * look), 'already_fixed' (byteLength already recorded), 'backfilled_metadata_only'
 * (measured-safe, cheap metadata patch applied), 'would_backfill_metadata_only'
 * (dryRun equivalent), 'repaired_via_fal' (measured-oversized, real fal
 * re-fetch + force re-host succeeded), 'would_repair_via_fal' (dryRun
 * equivalent), 'failed' (repair attempted — or, in dryRun, would have been
 * attempted — and could not complete; see `reason`).
 */
async function repairOneField(event, falKey, record, mediaType, dryRun, targetKeys) {
  var field = mediaType === 'image' ? 'imageUrl' : 'videoUrl';
  var url = record[field];
  if (!url || !mediaStatus.isDurableUrl(url)) return { outcome: null };

  var key = extractKeyFromDurableUrl(url);
  if (!key) return { outcome: 'failed', key: null, reason: 'unparseable_durable_url' };
  if (targetKeys && targetKeys.length > 0 && targetKeys.indexOf(key) === -1) return { outcome: null };

  connectLambda(event);
  var store = getStore({ name: mediaRehost.STORE_NAMES[mediaType] });

  var existing = await store.getMetadata(key);
  if (!existing) return { outcome: 'blob_missing', key: key };

  var meta = existing.metadata || {};
  if (typeof meta.byteLength === 'number') {
    return { outcome: 'already_fixed', key: key };
  }

  // No byteLength on file -- broken-metadata candidate (see this file's
  // header comment's TWO-TIER REPAIR section). Measure the REAL stored
  // size directly -- a plain Blobs read, no fal call, no cost.
  var raw = await store.get(key, { type: 'arrayBuffer' });
  if (!raw) return { outcome: 'blob_missing', key: key };
  var actualBytes = raw.byteLength;

  if (actualBytes <= mediaRehost.MAX_STREAMABLE_BYTES) {
    if (dryRun) return { outcome: 'would_backfill_metadata_only', key: key, byteLength: actualBytes };
    await store.set(key, raw, { metadata: Object.assign({}, meta, { byteLength: actualBytes }) });
    return { outcome: 'backfilled_metadata_only', key: key, byteLength: actualBytes };
  }

  // Genuinely oversized-and-broken -- needs the real (paid) fal re-fetch tier.
  var op = parseSourceOperationName(record);
  if (!op) return { outcome: 'failed', key: key, reason: 'missing_or_invalid_source_operation_name' };

  if (dryRun) return { outcome: 'would_repair_via_fal', key: key, byteLength: actualBytes };

  if (!falKey) return { outcome: 'failed', key: key, reason: 'missing_fal_key' };

  var fresh = await fetchFreshFalUrl(mediaType, op.model, op.requestId, falKey);
  if (!fresh.ok) return { outcome: 'failed', key: key, reason: fresh.reason };

  var rehost = await mediaRehost.rehostBestEffort(event, mediaType, fresh.url, key, { force: true });
  if (!rehost.ok && !rehost.tooLargeToServe) {
    return { outcome: 'failed', key: key, reason: 'rehost_fetch_failed' };
  }
  // Either genuinely fixed streamable-in-place (fal's current copy happens
  // to now be under the ceiling), or still oversized but NOW carrying real
  // sourceUrl+byteLength metadata -- either way video-file.mjs/
  // image-file.mjs can serve it correctly now (stream, or redirect to the
  // fresh fal url), which is the actual repair.
  return { outcome: 'repaired_via_fal', key: key, streamable: !!rehost.ok };
}

function blankCounts() {
  return {
    scannedAccounts: 0, scannedMediaItems: 0,
    alreadyFixed: 0, backfilledMetadataOnly: 0, repairedViaFal: 0,
    failed: 0, skippedNoDurableMedia: 0, blobMissing: 0
  };
}

function tally(counts, details, outcome, extra) {
  if (outcome === null) { counts.skippedNoDurableMedia++; return; }
  counts.scannedMediaItems++;
  if (outcome === 'blob_missing') counts.blobMissing++;
  else if (outcome === 'already_fixed') counts.alreadyFixed++;
  else if (outcome === 'backfilled_metadata_only' || outcome === 'would_backfill_metadata_only') counts.backfilledMetadataOnly++;
  else if (outcome === 'repaired_via_fal' || outcome === 'would_repair_via_fal') counts.repairedViaFal++;
  else if (outcome === 'failed') counts.failed++;

  if (details.length < MAX_DETAIL_ENTRIES) {
    details.push(Object.assign({ outcome: outcome }, extra));
  }
}

/** True if `targetDreamIds` is unset (no filter -- process everything) or contains `id`. */
function matchesTarget(targetDreamIds, id) {
  return !targetDreamIds || targetDreamIds.length === 0 || targetDreamIds.indexOf(id) !== -1;
}

async function repairRecord(event, falKey, record, isPublished, dryRun, targetKeys, counts, details) {
  var videoResult = await repairOneField(event, falKey, record, 'video', dryRun, targetKeys);
  tally(counts, details, videoResult.outcome, {
    dreamId: record.id, ownerHandle: record.ownerHandle || null, mediaType: 'video',
    isPublished: !!isPublished, key: videoResult.key || null, reason: videoResult.reason || null
  });

  var imageResult = await repairOneField(event, falKey, record, 'image', dryRun, targetKeys);
  tally(counts, details, imageResult.outcome, {
    dreamId: record.id, ownerHandle: record.ownerHandle || null, mediaType: 'image',
    isPublished: !!isPublished, key: imageResult.key || null, reason: imageResult.reason || null
  });
}

/** Sweeps up to `limit` accounts starting at `offset` in the private-dreams store's key list. Returns counts + details plus `nextOffset` (null if this was the last page). */
async function sweepAccountsPage(event, falKey, offset, limit, dryRun, targetDreamIds, targetKeys) {
  connectLambda(event);
  var store = getStore({ name: dreamStore.STORE_NAME });
  var listResult = await store.list();
  var keys = listResult.blobs.map(function (b) { return b.key; });

  var counts = blankCounts();
  var details = [];
  var page = keys.slice(offset, offset + limit);

  for (var i = 0; i < page.length; i++) {
    var username = page[i];
    counts.scannedAccounts++;
    var dreams = await dreamStore.getPrivateDreams(event, username);

    for (var d = 0; d < dreams.length; d++) {
      var dream = dreams[d];
      if (!matchesTarget(targetDreamIds, dream.id)) continue;
      await repairRecord(event, falKey, dream, false, dryRun, targetKeys, counts, details);
    }
  }

  var nextOffset = (offset + limit) < keys.length ? (offset + limit) : null;
  return Object.assign({}, counts, { details: details, totalAccounts: keys.length, nextOffset: nextOffset });
}

/** Sweeps the entire shared published feed in one pass (small, single-blob store — see admin-backfill-media-rehost.js's identical sweepFeed). */
async function sweepFeed(event, falKey, dryRun, targetDreamIds, targetKeys) {
  connectLambda(event);
  var store = getStore(FEED_STORE_NAME);
  var feed = (await store.get(FEED_KEY, { type: 'json' })) || [];

  var counts = blankCounts();
  var details = [];

  for (var i = 0; i < feed.length; i++) {
    var record = feed[i];
    if (!matchesTarget(targetDreamIds, record.id)) continue;
    await repairRecord(event, falKey, record, true, dryRun, targetKeys, counts, details);
  }

  return Object.assign({}, counts, { details: details });
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

  var limit = ACCOUNTS_PER_CALL_DEFAULT;
  if (payload.limit !== undefined) {
    var parsedLimit = parseInt(payload.limit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_LIMIT) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'E7: invalid_limit' }) };
    }
    limit = parsedLimit;
  }

  var dryRun = payload.dryRun === true;
  var targetDreamIds = Array.isArray(payload.targetDreamIds)
    ? payload.targetDreamIds.filter(function (id) { return typeof id === 'string' && id; })
    : null;
  var targetKeys = Array.isArray(payload.targetKeys)
    ? payload.targetKeys.filter(function (k) { return typeof k === 'string' && k; })
    : null;

  // Generous daily ceiling, same reasoning as admin-backfill-media-rehost.js's
  // own — a real sweep needs many successive paginated calls in one day.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_OVERSIZED_MEDIA_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 1000;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_REPAIR_OVERSIZED_MEDIA_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 1000;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-oversized-media-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-repair-oversized-media-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var falKey = process.env.FAL_KEY || null;
  var cursor = payload.cursor;

  try {
    if (cursor === 'feed') {
      var feedResult = await sweepFeed(event, falKey, dryRun, targetDreamIds, targetKeys);
      return {
        statusCode: 200,
        body: JSON.stringify(Object.assign({ ok: true, phase: 'feed', dryRun: dryRun, nextCursor: null, done: true }, feedResult))
      };
    }

    var offset = 0;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      var parsedCursor = parseInt(cursor, 10);
      if (Number.isInteger(parsedCursor) && parsedCursor >= 0) offset = parsedCursor;
    }

    var page = await sweepAccountsPage(event, falKey, offset, limit, dryRun, targetDreamIds, targetKeys);
    var accountsExhausted = page.nextOffset === null;
    var nextCursor = accountsExhausted ? 'feed' : String(page.nextOffset);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, phase: 'accounts', dryRun: dryRun,
        scannedAccounts: page.scannedAccounts, scannedMediaItems: page.scannedMediaItems,
        alreadyFixed: page.alreadyFixed, backfilledMetadataOnly: page.backfilledMetadataOnly,
        repairedViaFal: page.repairedViaFal, failed: page.failed,
        skippedNoDurableMedia: page.skippedNoDurableMedia, blobMissing: page.blobMissing,
        details: page.details,
        totalAccounts: page.totalAccounts,
        nextCursor: nextCursor, done: false
      })
    };
  } catch (e) {
    console.error('admin-repair-oversized-media: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'sweep_failed: ' + (e && e.message) }) };
  }
};
