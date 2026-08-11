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
// created/published status) across the whole app — the single most
// sensitive read surface this codebase has short of the raw account store
// itself. Gated the same real-password + OWNER_EMAIL bar as every sibling
// admin diagnostic (see admin-diagnose-account-duplicates.js's own header
// comment) — POST-only, so the password is never in a URL/query string
// that could end up in server logs.
//
// storyText (tracker item for-product-media-library-founder-08-03--6h7fmv,
// founder: "also show the text they wrote") — this WAS the one deliberate
// exception to the "captions are not included" line above, until the
// founder explicitly asked for it. Uses `record.storyText || record.caption
// || null`, the same fallback js/store.js's own doc comment documents
// everywhere else in the app (js/store.js's header comment, tileHTML in
// js/dream-cards.js): storyText is the NEW, separate, human-readable
// first-person dream description the user actually typed (tracker item
// for-product-split-prompttext-storytext-f-yt5kc7); `record.promptText` is
// a DIFFERENT field — the engineered generation prompt, never what the
// user typed, and deliberately never surfaced here. A dream saved before
// the storyText/promptText split shipped has no distinct storyText at all,
// so `caption` (which served both roles pre-split) is the correct
// fallback, not a bug. A FEED (published) record never carries a separate
// storyText field to begin with (see publish-dream.js's own payload
// shape) — its `caption` already equals its storyText per finalizeDream's
// own guarantee (see js/store.js), so the same `|| record.caption`
// fallback resolves it correctly without any FEED-specific branch.
//
// createdAt for a FEED (published) record: publish-dream.js now stamps a
// real createdAt on every feed record going forward (tracker item
// for-product-media-library-stamp-durable--u4oju3 — see that file's own
// header comment for the full "stamp at first-create, preserve immutably,
// opportunistically backfill a pre-fix record" design). A record written
// before that fix shipped (or one whose owning client never sent a real
// generation-time value even after the fix, e.g. a very old app version)
// simply has no createdAt of its own — collectFeedItems below falls back to
// publishedAt for exactly that case, the same approximation this file used
// unconditionally before the fix (per lib/media-status.js's own header
// comment). A dream published well after it was actually generated will,
// in that fallback case only, show a slightly later "created" date and a
// slightly more optimistic still-on-fal estimate than reality — an
// accepted, documented imprecision for un-derivable legacy records, not a
// silent guess for anything this fix can actually stamp correctly.
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

/**
 * Emits the media card(s) for one dream/feed record — see this file's header
 * comment on shared classification.
 *
 * A VIDEO dream emits exactly ONE card (the video), carrying its auto-captured
 * first-frame STILL (`record.imageUrl`, from upload-dream-thumbnail.js) as the
 * card's display `thumbnailUrl`/poster. It must NOT also emit a separate
 * "image" card for that still — the still is not a user-created image (founder
 * 2026-08-11: "Don't show such images in media library unless created by the
 * user"). A genuine USER-CREATED IMAGE dream (the flux image-generation
 * feature, `mediaType:'image'`) still emits its own image card unchanged — the
 * discriminator is `record.mediaType` (falling back to "has a videoUrl" for a
 * legacy record with no mediaType), never a blind "every imageUrl is a card".
 */
function itemsForRecord(record, createdAt, isPublished) {
  var items = [];
  var storyText = record.storyText || record.caption || null; // header comment (storyText paragraph): fallback reasoning; promptText deliberately excluded

  // Video dream if it declares mediaType 'video', or (legacy, no mediaType) it
  // simply has a videoUrl.
  var isVideoDream = record.mediaType === 'video' || (record.mediaType !== 'image' && !!record.videoUrl);

  if (record.videoUrl) {
    var vClassified = mediaStatus.classifyMediaUrl(record.videoUrl, createdAt);
    items.push({
      id: record.id + ':video',
      dreamId: record.id,
      ownerHandle: record.ownerHandle || null,
      mediaType: 'video',
      url: record.videoUrl,
      // The auto-captured first-frame still — shown as the card's poster so a
      // lazy/preload=none <video> isn't a black rectangle (founder screenshot).
      thumbnailUrl: record.imageUrl || null,
      createdAt: createdAt || null,
      isPublished: !!isPublished,
      status: vClassified.status,
      protectedByNoExpiryHeader: vClassified.protectedByNoExpiryHeader,
      daysUntilExpiry: vClassified.daysUntilExpiry,
      storyText: storyText
    });
  }

  // Genuine user-created image (flux) — never a video's own first-frame still.
  if (record.imageUrl && !isVideoDream) {
    var iClassified = mediaStatus.classifyMediaUrl(record.imageUrl, createdAt);
    items.push({
      id: record.id + ':image',
      dreamId: record.id,
      ownerHandle: record.ownerHandle || null,
      mediaType: 'image',
      url: record.imageUrl,
      thumbnailUrl: record.imageUrl,
      createdAt: createdAt || null,
      isPublished: !!isPublished,
      status: iClassified.status,
      protectedByNoExpiryHeader: iClassified.protectedByNoExpiryHeader,
      daysUntilExpiry: iClassified.daysUntilExpiry,
      storyText: storyText
    });
  }

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
      // Prefer the real stamped createdAt; fall back to the dream's own
      // updatedAt for a HISTORICAL record that predates createdAt stamping
      // (every private dream carries a real updatedAt — dream-sync.js sets
      // `out.updatedAt = Date.now()` on sync if missing). Without this, an old
      // private video rendered a BLANK timestamp and sank to the bottom of the
      // newest-first sort (founder report). Mirrors the feed side's own
      // publishedAt fallback in collectFeedItems below.
      items = items.concat(itemsForRecord(dreams[d], dreams[d].createdAt || dreams[d].updatedAt || null, false));
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
    // Prefer the real stamped createdAt (see this file's own header comment
    // on the "createdAt for a FEED record" fix); fall back to publishedAt
    // only for a record this fix can't retroactively repair.
    items = items.concat(itemsForRecord(feed[i], feed[i].createdAt || feed[i].publishedAt || null, true));
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
