// netlify/functions/admin-backfill-media-rehost.js
//
// Owner-only, real-password-gated BACKFILL SWEEP: re-hosts existing dreams'
// media (private + published) into our own Blobs storage, for anything
// still on fal and not yet durably hosted — tracker item
// for-product-owner-media-library-page-fou-1fwxaw's corrected scope (Part
// 2), closing the founder's own 2026-07-29 directive on
// for-product-bug-build-re-host-image-drea-0hpbm0 that was captured as a
// tracker comment but never actually built ("we want to store all created
// videos and images somewhere ... regardless of these projects"). See
// lib/media-rehost.js's own header comment for why this is a SEPARATE
// layer of defense from generate-video.js's/generate-image.js's
// FAL_NO_EXPIRY_HEADER, and lib/media-status.js's header comment for the
// exact cutoff/classification logic this sweep and the media library page
// both share.
//
// GOING FORWARD, this sweep is mostly redundant: video-status.js/
// image-status.js/dream-webhook.js now re-host on EVERY new completion
// (see lib/media-rehost.js). This tool exists purely to catch dreams
// generated BEFORE that re-host step shipped — a real, one-time (well,
// safely re-runnable) gap, not an ongoing job. No scheduled trigger; run it
// manually (or from the owner media library page, once wired) until it
// reports done:true with nothing left to do.
//
// SCOPE: sweeps BOTH real dream stores this app has —
//   (1) lib/dream-store.js's "dreamtube-private-dreams" (one Blobs record
//       per account, keyed by username — see that file's header comment).
//       Enumerated via the Blobs SDK's own list() (no separate index
//       needed), same "O(n) full-store scan, fine at this app's current
//       real scale" reasoning send-daily-claim-pushes.js's own header
//       comment already documents for an identical shape.
//   (2) the shared published feed ("dreamtube-feed", get-feed.js/
//       publish-dream.js) — a single small JSON array, processed in one
//       pass (no pagination needed for a store this size).
//
// BATCHING/PAGINATION: a Netlify Function has a real execution-time
// ceiling, and a full sweep across every account is an unbounded-by-this-
// code loop over however many accounts exist — this app is real-user-early
// stage today (FOUNDER_PRINCIPLES.md's own "~0 users affected at current
// traffic" framing elsewhere in this codebase), so a single call is very
// likely fine in practice, but this endpoint does NOT assume that: it
// processes at most `limit` accounts (default ACCOUNTS_PER_CALL, caller-
// tunable up to MAX_LIMIT) per call and returns a `cursor` the caller
// passes back to continue, exactly the same "safely re-runnable, always
// reports progress" shape as tracker-store.js's own paginated read helpers.
// The published feed is swept as its own separate, later phase (cursor
// value 'feed') — see CURSOR SHAPE below.
//
// CURSOR SHAPE: either an unset/absent value (start of the accounts phase),
// a stringified non-negative integer (the next offset into the accounts
// key list), or the literal string 'feed' (process the shared feed, which
// always completes in one call given its size — see above). The response's
// own `nextCursor` is exactly what the next call should pass back;
// `done: true` means there is nothing left to sweep in EITHER phase.
//
// IDEMPOTENT: every dream/feed record is checked against
// lib/media-status.js's isDurableUrl BEFORE attempting anything, and
// lib/media-rehost.js's own rehostBestEffort is independently idempotent
// too (checks the Blobs key first) — running this sweep twice (or
// resuming a partial sweep after a failure) never re-downloads or
// duplicates storage for anything already durably hosted; it just reports
// alreadyDurable for those items on the re-run.
//
// AUTH: same bar as every sibling admin diagnostic in this codebase — real,
// server-verified password (lib/account-store.js's verifyLogin) against an
// account whose own on-file email matches OWNER_EMAIL. Duplicated inline
// rather than shared, matching this codebase's explicit precedent (see
// admin-diagnose-account-duplicates.js's own header comment).
//
// RATE LIMITING: same two-bucket (per-IP + per-identifier) shape as every
// sibling admin tool, but with a materially higher daily ceiling than a
// typical one-off diagnostic — a real sweep across many accounts needs
// many successive paginated calls in the same day, not just one or two.
//
// Request: POST { usernameOrEmail, password, cursor?, limit? }
// Response: 200 { ok:true, phase, scannedAccounts, scannedMediaItems,
//   rehosted, alreadyDurable, skippedNoMedia, failed, nextCursor, done }
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

/**
 * Attempts to re-host ONE media field (videoUrl or imageUrl) already on
 * `record` (a private dream or a feed entry — both carry the same field
 * names), keyed by `record.id + ':' + mediaType` (see lib/media-rehost.js's
 * header comment on key-namespace safety — this backfill path uses its own
 * id-based key rather than the live path's fal-requestId-based key, since a
 * pre-existing dream record has no operationName reliably available in
 * every shape this store has accumulated over time; the two key spaces
 * cannot collide since fal's own request ids never contain a literal ':').
 * Mutates nothing — returns { changed, url, outcome } for the caller to act
 * on, where outcome is 'rehosted' | 'already_durable' | 'failed'.
 */
async function rehostOneField(event, record, mediaType) {
  var field = mediaType === 'image' ? 'imageUrl' : 'videoUrl';
  var url = record[field];
  if (!url) return { changed: false, outcome: null };

  if (mediaStatus.isDurableUrl(url)) {
    return { changed: false, outcome: 'already_durable' };
  }

  var key = record.id + ':' + mediaType;
  var result = await mediaRehost.rehostBestEffort(event, mediaType, url, key);
  if (!result.ok) return { changed: false, outcome: 'failed' };
  return { changed: true, outcome: 'rehosted', field: field, url: result.url };
}

/** Sweeps up to `limit` accounts starting at `offset` in the private-dreams store's key list. Returns counts plus `nextOffset` (null if this was the last page). */
async function sweepAccountsPage(event, offset, limit) {
  connectLambda(event);
  var store = getStore({ name: dreamStore.STORE_NAME });
  var listResult = await store.list();
  var keys = listResult.blobs.map(function (b) { return b.key; });

  var counts = { scannedAccounts: 0, scannedMediaItems: 0, rehosted: 0, alreadyDurable: 0, skippedNoMedia: 0, failed: 0 };
  var page = keys.slice(offset, offset + limit);

  for (var i = 0; i < page.length; i++) {
    var username = page[i];
    counts.scannedAccounts++;
    var dreams = await dreamStore.getPrivateDreams(event, username);

    for (var d = 0; d < dreams.length; d++) {
      var dream = dreams[d];
      var patch = {};
      var anyChanged = false;

      var videoResult = await rehostOneField(event, dream, 'video');
      if (videoResult.outcome) counts.scannedMediaItems++;
      if (videoResult.outcome === 'rehosted') { counts.rehosted++; patch.videoUrl = videoResult.url; anyChanged = true; }
      else if (videoResult.outcome === 'already_durable') counts.alreadyDurable++;
      else if (videoResult.outcome === 'failed') counts.failed++;

      var imageResult = await rehostOneField(event, dream, 'image');
      if (imageResult.outcome) counts.scannedMediaItems++;
      if (imageResult.outcome === 'rehosted') { counts.rehosted++; patch.imageUrl = imageResult.url; anyChanged = true; }
      else if (imageResult.outcome === 'already_durable') counts.alreadyDurable++;
      else if (imageResult.outcome === 'failed') counts.failed++;

      if (!videoResult.outcome && !imageResult.outcome) counts.skippedNoMedia++;

      if (anyChanged) {
        var updated = Object.assign({}, dream, patch);
        await dreamStore.upsertPrivateDream(event, username, updated);
      }
    }
  }

  var nextOffset = (offset + limit) < keys.length ? (offset + limit) : null;
  return Object.assign({}, counts, { totalAccounts: keys.length, nextOffset: nextOffset });
}

/** Sweeps the entire shared published feed in one pass (small, single-blob store — see header comment). */
async function sweepFeed(event) {
  connectLambda(event);
  var store = getStore(FEED_STORE_NAME);
  var feed = (await store.get(FEED_KEY, { type: 'json' })) || [];

  var counts = { scannedAccounts: 0, scannedMediaItems: 0, rehosted: 0, alreadyDurable: 0, skippedNoMedia: 0, failed: 0 };
  var anyChanged = false;

  for (var i = 0; i < feed.length; i++) {
    var record = feed[i];
    var patch = {};
    var recordChanged = false;

    var videoResult = await rehostOneField(event, record, 'video');
    if (videoResult.outcome) counts.scannedMediaItems++;
    if (videoResult.outcome === 'rehosted') { counts.rehosted++; patch.videoUrl = videoResult.url; recordChanged = true; }
    else if (videoResult.outcome === 'already_durable') counts.alreadyDurable++;
    else if (videoResult.outcome === 'failed') counts.failed++;

    var imageResult = await rehostOneField(event, record, 'image');
    if (imageResult.outcome) counts.scannedMediaItems++;
    if (imageResult.outcome === 'rehosted') { counts.rehosted++; patch.imageUrl = imageResult.url; recordChanged = true; }
    else if (imageResult.outcome === 'already_durable') counts.alreadyDurable++;
    else if (imageResult.outcome === 'failed') counts.failed++;

    if (!videoResult.outcome && !imageResult.outcome) counts.skippedNoMedia++;

    if (recordChanged) {
      Object.assign(feed[i], patch);
      anyChanged = true;
    }
  }

  if (anyChanged) await store.setJSON(FEED_KEY, feed);
  return counts;
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

  // Generous daily ceiling — see header comment on why this needs to
  // support many successive paginated calls in one sweep session, unlike a
  // typical single-shot admin diagnostic.
  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_BACKFILL_MEDIA_REHOST_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 1000;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_BACKFILL_MEDIA_REHOST_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 1000;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-backfill-media-rehost-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-backfill-media-rehost-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  var cursor = payload.cursor;

  try {
    if (cursor === 'feed') {
      var feedCounts = await sweepFeed(event);
      return {
        statusCode: 200,
        body: JSON.stringify(Object.assign({ ok: true, phase: 'feed', nextCursor: null, done: true }, feedCounts))
      };
    }

    var offset = 0;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      var parsedCursor = parseInt(cursor, 10);
      if (Number.isInteger(parsedCursor) && parsedCursor >= 0) offset = parsedCursor;
    }

    var page = await sweepAccountsPage(event, offset, limit);
    var accountsExhausted = page.nextOffset === null;
    var nextCursor = accountsExhausted ? 'feed' : String(page.nextOffset);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, phase: 'accounts',
        scannedAccounts: page.scannedAccounts, scannedMediaItems: page.scannedMediaItems,
        rehosted: page.rehosted, alreadyDurable: page.alreadyDurable,
        skippedNoMedia: page.skippedNoMedia, failed: page.failed,
        totalAccounts: page.totalAccounts,
        nextCursor: nextCursor, done: false
      })
    };
  } catch (e) {
    console.error('admin-backfill-media-rehost: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'sweep_failed: ' + (e && e.message) }) };
  }
};
