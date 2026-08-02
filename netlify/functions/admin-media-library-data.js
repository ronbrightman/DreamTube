// netlify/functions/admin-media-library-data.js
//
// Owner-only, real-password-gated data feed for media-library-x7q4.html —
// tracker item for-product-owner-media-library-page-fou-1fwxaw (Part 3):
// "grid of ALL user videos across accounts ... and STORAGE STATUS per item
// ... build it against the SAME server-side data the backfill sweeps, so
// counts match." Reads exactly the two real stores
// admin-backfill-media-rehost.js sweeps — lib/dream-store.js's
// "dreamtube-private-dreams" and the shared "dreamtube-feed" — and
// classifies every media item through the SAME lib/media-status.js
// classifyMediaUrl function that sweep's own isDurableUrl check is built
// on, so this page's counts can never diverge from what a sweep actually
// did/would do. See that lib's own header comment for the full "why a pure
// function of the URL, not a separate stored flag" reasoning.
//
// SCOPE/SCALE: unpaginated — reads every account's private dreams plus the
// whole shared feed in one call. Same "fine at this app's current real
// scale, would need real pagination once the account base is large"
// tradeoff send-daily-claim-pushes.js's own header comment already accepts
// for an identical full-store-scan shape; not a concern worth solving here
// yet (see FOUNDER_PRINCIPLES.md's own current-scale framing).
//
// PRIVACY: this reads every real account's dream content (media URLs,
// captions are NOT included — only the fields the owner page actually
// needs to render: id, ownerHandle, mediaType, url, createdAt, published
// status) across the whole app — the single most sensitive read surface
// this codebase has short of the raw account store itself. Gated the same
// real-password + OWNER_EMAIL bar as every sibling admin diagnostic (see
// admin-diagnose-account-duplicates.js's own header comment) — POST-only,
// so the password is never in a URL/query string that could end up in
// server logs.
//
// createdAt for a FEED (published) record: the shared feed store carries no
// createdAt at all, only publishedAt (see get-feed.js/publish-dream.js) —
// used here as the best available stand-in, per lib/media-status.js's own
// header comment on exactly this approximation. A dream published well
// after it was actually generated will show a slightly later "created"
// date and a slightly more optimistic still-on-fal estimate than reality;
// an accepted, documented imprecision, not a silent guess.
//
// Error codes (same small-number scheme as every sibling admin-*.js file):
//   E1 method_not_allowed
//   E2 missing_owner_email
//   E3 invalid_json
//   E4 missing_fields
//   E5 forbidden
//   E6 rate_limited

var { getStore, connectLambda } = require('@netlify/blobs');
var accountStore = require('./lib/account-store');
var dreamStore = require('./lib/dream-store');
var { normalizeEmail } = require('./lib/entitlements');
var rateLimit = require('./lib/rate-limit');
var mediaStatus = require('./lib/media-status');

var FEED_STORE_NAME = 'dreamtube-feed';
var FEED_KEY = 'feed-index';

/** Real, server-verified credential check + owner-email confirmation — duplicated from admin-diagnose-account-duplicates.js's own copy, see that file's header comment. */
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

/** Emits 0-2 items (one per present videoUrl/imageUrl) for one dream/feed record — see this file's header comment on shared classification. */
function itemsForRecord(record, createdAt, isPublished) {
  var items = [];
  ['video', 'image'].forEach(function (mediaType) {
    var field = mediaType === 'image' ? 'imageUrl' : 'videoUrl';
    var url = record[field];
    if (!url) return;
    var classified = mediaStatus.classifyMediaUrl(url, createdAt);
    items.push({
      id: record.id + ':' + mediaType,
      dreamId: record.id,
      ownerHandle: record.ownerHandle || null,
      mediaType: mediaType,
      url: url,
      createdAt: createdAt || null,
      isPublished: !!isPublished,
      status: classified.status,
      protectedByNoExpiryHeader: classified.protectedByNoExpiryHeader,
      daysUntilExpiry: classified.daysUntilExpiry
    });
  });
  return items;
}

/** Reads every account's private dreams (dream-store.js's own list()-based enumeration — same pattern admin-backfill-media-rehost.js/send-daily-claim-pushes.js already use). */
async function collectPrivateItems(event) {
  connectLambda(event);
  var store = getStore({ name: dreamStore.STORE_NAME });
  var listResult = await store.list();

  var items = [];
  var scannedAccounts = 0;
  for (var i = 0; i < listResult.blobs.length; i++) {
    var username = listResult.blobs[i].key;
    scannedAccounts++;
    var dreams = await dreamStore.getPrivateDreams(event, username);
    for (var d = 0; d < dreams.length; d++) {
      items = items.concat(itemsForRecord(dreams[d], dreams[d].createdAt || null, false));
    }
  }
  return { items: items, scannedAccounts: scannedAccounts };
}

/** Reads the whole shared published feed in one pass — small, single-blob store, same as admin-backfill-media-rehost.js's sweepFeed. */
async function collectFeedItems(event) {
  connectLambda(event);
  var store = getStore(FEED_STORE_NAME);
  var feed = (await store.get(FEED_KEY, { type: 'json' })) || [];

  var items = [];
  for (var i = 0; i < feed.length; i++) {
    items = items.concat(itemsForRecord(feed[i], feed[i].publishedAt || null, true));
  }
  return items;
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

  var maxPerIpPerDay = parseInt(process.env.MAX_ADMIN_MEDIA_LIBRARY_DATA_PER_IP_PER_DAY, 10);
  if (!maxPerIpPerDay || maxPerIpPerDay <= 0) maxPerIpPerDay = 200;
  var maxPerIdentifierPerDay = parseInt(process.env.MAX_ADMIN_MEDIA_LIBRARY_DATA_PER_IDENTIFIER_PER_DAY, 10);
  if (!maxPerIdentifierPerDay || maxPerIdentifierPerDay <= 0) maxPerIdentifierPerDay = 200;

  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'admin-media-library-data-ip', ip, maxPerIpPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts from this network today, try again tomorrow' }) };
  }

  var canonicalAccount = await accountStore.getByUsername(event, usernameOrEmail);
  if (!canonicalAccount) canonicalAccount = await accountStore.getByEmail(event, usernameOrEmail);
  var identifierKey = canonicalAccount ? canonicalAccount.username : usernameOrEmail.toLowerCase();
  var identifierLimit = await rateLimit.checkAndIncrement(event, 'admin-media-library-data-identifier', identifierKey, maxPerIdentifierPerDay);
  if (!identifierLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ ok: false, error: 'E6: rate_limited: too many attempts for this account today, try again tomorrow' }) };
  }

  var auth = await verifyOwnerCredentials(event, usernameOrEmail, password);
  if (!auth.ok) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'E5: forbidden' }) };
  }

  try {
    var privateResult = await collectPrivateItems(event);
    var feedItems = await collectFeedItems(event);
    var items = privateResult.items.concat(feedItems);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        generatedAt: Date.now(),
        scannedAccounts: privateResult.scannedAccounts,
        items: items
      })
    };
  } catch (e) {
    console.error('admin-media-library-data: unexpected error', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'fetch_failed: ' + (e && e.message) }) };
  }
};
