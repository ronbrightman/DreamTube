// netlify/functions/lib/media-status.js
//
// Single source of truth for "is this dream's media durably hosted" —
// tracker item for-product-owner-media-library-page-fou-1fwxaw's corrected,
// full scope (see that item's own pickup comment). Read by BOTH the
// backfill sweep (admin-backfill-media-rehost.js) and the owner media
// library page's data endpoint (admin-media-library-data.js), so their
// counts can never diverge (the tracker item's own explicit requirement:
// "build it against the same server-side data the backfill sweeps, so
// counts match") — there is no separate stored boolean anywhere that could
// drift out of sync with the URL a dream's own videoUrl/imageUrl field
// actually holds. Status is a PURE function of that one field (plus
// createdAt, for the still-on-fal age estimate) — nothing here mutates
// anything, this module is read-only classification logic.
//
// WHY A URL-SHAPE CHECK, NOT A SEPARATE "durable: true" FIELD: the re-host
// step (lib/media-rehost.js, called from video-status.js/image-status.js/
// dream-webhook.js at the moment a generation completes) REPLACES a dream's
// videoUrl/imageUrl with our own durable /.netlify/functions/video-file or
// .../image-file URL when it succeeds, and leaves fal's own URL in place
// when it fails/is skipped. That means the URL a dream record already
// carries IS the durability signal — a dedicated boolean field would be
// redundant, could silently drift from the URL actually being played (e.g.
// if a future migration ever rewrites urls without remembering to also flip
// the flag), and would need its own write path threaded through every
// completion path this app has. Deriving status from the URL string itself
// has none of those failure modes.
//
// NO-EXPIRY-HEADER CUTOFF: generate-video.js's/generate-image.js's
// FAL_NO_EXPIRY_HEADER shipped in commit a098b14 (2026-07-29T06:43:46Z,
// tracker item for-product-bug-build-re-host-image-drea-0hpbm0) — every fal
// generation SUBMITTED at or after that moment asked fal to never expire
// the resulting media at all. So a dream created after this cutoff that's
// still only on fal (re-host never ran yet, or failed) is not actually at
// any KNOWN expiry risk, unlike one from before it, which is subject to
// fal's plain ~7-day retention window with no protection at all. This is an
// honest ESTIMATE, not a guarantee — this codebase's own tracker comment on
// a098b14 notes nobody could confirm fal actually honors the header on a
// real call (no live FAL_KEY in this sandbox) — but it's the best-founded
// assumption available, and a real improvement over a blanket 7-day
// countdown applied to every dream regardless of when it was made.
//
// createdAt SOURCE: a private dream (dream-store.js) carries a real
// createdAt (js/store.js's finalizeDream — forward-only migration, absent
// on dreams made before that field existed). A published feed record
// (get-feed.js/publish-dream.js) carries no createdAt at all, only
// publishedAt (the moment it was first published, which can be well after
// the dream was actually generated) — callers reading a feed record should
// pass publishedAt as the best available stand-in; see
// admin-media-library-data.js's/admin-backfill-media-rehost.js's own
// comments at their feed-record call sites for why that's an accepted,
// documented approximation, not a precise value.

var NO_EXPIRY_HEADER_SHIP_AT = Date.parse('2026-07-29T06:43:46Z');
var FAL_RETENTION_DAYS = 7;
var FAL_RETENTION_MS = FAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Matches lib/media-rehost.js's own durableUrl() output shape exactly —
// duplicated as a literal (not required from that module) so this stays
// pure classification logic with zero dependency on the re-host mechanism
// itself, same "each piece self-contained" reasoning this codebase already
// applies to its per-file duplicated helpers (see e.g. image-status.js's
// header comment on duplicating parseJsonSafe/falAppBase from
// video-status.js).
var DURABLE_URL_PREFIXES = [
  '/.netlify/functions/video-file?',
  '/.netlify/functions/image-file?'
];

/** True if `url` already points at our own Blobs-backed video-file/image-file function (see lib/media-rehost.js's durableUrl). */
function isDurableUrl(url) {
  return typeof url === 'string' && DURABLE_URL_PREFIXES.some(function (prefix) { return url.indexOf(prefix) === 0; });
}

/**
 * Classifies ONE media url (whichever of a dream/feed record's
 * videoUrl/imageUrl is being asked about — see callers, which call this
 * once per non-empty media field on a record, since a single dream can
 * carry both, e.g. after the "turn image into video" upsell keeps the
 * original imageUrl for provenance alongside a new videoUrl).
 *
 * `createdAt` is the best available epoch-ms "when was this actually
 * generated" for the url being classified — null/undefined is treated as
 * "unknown," which for a still-on-fal url means the worst case (no
 * no-expiry-header protection can be assumed, and age can't be computed at
 * all, so it degrades straight to lost-expired — there is no way to say
 * anything more optimistic about a record with literally no timestamp).
 *
 * Returns { status, protectedByNoExpiryHeader, daysUntilExpiry }:
 *   status one of:
 *     're-hosted-durable' — url already points at our own Blobs-backed
 *       function (see isDurableUrl above). Nothing else on the return
 *       value is meaningful for this status.
 *     'still-on-fal'       — url is still fal's own URL, and either (a)
 *       protected by the no-expiry header (createdAt at/after the cutoff,
 *       see header comment) — daysUntilExpiry is null, since there's no
 *       known countdown to report — or (b) predates that header but is
 *       still within FAL_RETENTION_DAYS of createdAt — daysUntilExpiry is
 *       the honest (possibly 0) number of days left in that estimate.
 *     'lost-expired'       — predates the no-expiry header (or has no
 *       createdAt at all) AND is past FAL_RETENTION_DAYS — fal's own
 *       retention window has almost certainly already elapsed, and there
 *       is no durable copy. Nothing can recover this; callers should say
 *       so plainly (see the media library page).
 * A falsy `url` is not a valid input — callers only ever call this once
 * they already know the field is present; there is deliberately no
 * 'no-media' status here (see admin-media-library-data.js's own filtering).
 */
function classifyMediaUrl(url, createdAt) {
  if (isDurableUrl(url)) {
    return { status: 're-hosted-durable', protectedByNoExpiryHeader: false, daysUntilExpiry: null };
  }

  var created = (typeof createdAt === 'number' && isFinite(createdAt)) ? createdAt : null;
  var protectedByNoExpiryHeader = created !== null && created >= NO_EXPIRY_HEADER_SHIP_AT;
  if (protectedByNoExpiryHeader) {
    return { status: 'still-on-fal', protectedByNoExpiryHeader: true, daysUntilExpiry: null };
  }

  var ageMs = created !== null ? (Date.now() - created) : Infinity;
  if (ageMs > FAL_RETENTION_MS) {
    return { status: 'lost-expired', protectedByNoExpiryHeader: false, daysUntilExpiry: 0 };
  }
  var daysUntilExpiry = Math.max(0, Math.ceil((FAL_RETENTION_MS - ageMs) / (24 * 60 * 60 * 1000)));
  return { status: 'still-on-fal', protectedByNoExpiryHeader: false, daysUntilExpiry: daysUntilExpiry };
}

module.exports = {
  isDurableUrl,
  classifyMediaUrl,
  NO_EXPIRY_HEADER_SHIP_AT,
  FAL_RETENTION_DAYS,
  FAL_RETENTION_MS,
  DURABLE_URL_PREFIXES
};
