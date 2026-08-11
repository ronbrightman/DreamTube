// netlify/functions/lib/public-feed-record.js
//
// Strips internal bookkeeping fields off a shared feed-index dream record
// before it's serialized into a public API response — get-feed.js's own
// `feed` array and get-profile.js's own `dreams` array (both read the
// SAME feed-index records — see get-profile.js's own header comment).
// Tracker item minor-like-dream-js-internal-dedup-marke-8qztvq: three
// internal markers were confirmed leaking through both endpoints today —
// `_lastLikeOp` (like-dream.js's now-retired per-request dedup marker,
// still present on any OLD record stamped before that file's CAS
// rewrite — see that file's own header comment for why new writes no
// longer add it), `_lostLikeRepairs` (admin-repair-feed-likes.js's
// one-off repair-tracking marker), and `_lastCommentCountOp`
// (lib/feed-comment-count.js's idempotent-write marker, same shape as
// `_lastLikeOp`). Low severity — opaque marker values, no PII — but they
// were never meant to be part of either endpoint's public response
// contract.
//
// APPROACH: a convention-based blocklist (strip any top-level key
// starting with `_`), not a hardcoded list of the three known field names,
// and not a field whitelist. Both alternatives were considered:
//
// - A named blocklist (`['_lastLikeOp', '_lostLikeRepairs',
//   '_lastCommentCountOp']`) would close today's leak but silently stops
//   covering the NEXT internal marker the moment someone adds one and
//   forgets to update this file — exactly the bug this fix exists to
//   close, just deferred.
//
// - A field whitelist (only ever emit an explicitly-named set of public
//   fields) was the other real option — get-profile.js's own header
//   comment already documents the exact field list clients currently read
//   (id/ownerHandle/caption/style/dur/videoUrl/imageUrl/mediaType/avatar/
//   likes/publishedAt/commentCount/...), which would make one *tractable*
//   to write today. But this repo doesn't have sole ownership of every
//   real consumer: get-feed.js's own header comment documents that the
//   separate dreamtube-growth marketing repo fetches this same response
//   cross-origin (open CORS, no auth) for its own social-proof carousels,
//   and this repo has no visibility into what fields that UI reads. A
//   strict whitelist risks silently breaking a field a consumer this repo
//   can't see actually depends on, the moment a legitimate new public
//   field is added here without the whitelist being updated in the same
//   breath — trading today's low-severity leak for a higher-severity
//   silent breakage, which is a worse deal.
//
// Every internal bookkeeping marker actually stamped onto a record
// anywhere in this codebase already follows one real, consistent naming
// convention: a leading underscore — `_lastLikeOp`, `_lostLikeRepairs`,
// `_lastCommentCountOp`, and the same pattern on other stores' records
// too (`_lastFollowerCountOp` in lib/follow-store.js, `_transitionClaim`
// in lib/pending-dreams.js, `_syncMarker` in lib/dream-store.js,
// `_consumeClaim` in lib/session-transfer-token.js). So this strips by PATTERN rather than
// by name: any top-level key starting with `_` is dropped, silently
// covering a future internal marker that follows the codebase's own
// existing convention with no edit needed here. No currently-real public
// field on a feed record starts with `_` (see get-profile.js's own field
// list above), so this introduces no false-positive stripping today.
//
// Residual, accepted risk: this only protects markers that follow the
// underscore convention. An internal field added WITHOUT a leading
// underscore would still leak — but that would just repeat this exact
// tracker item's own bug class, at the same low/no-PII severity already
// judged "not urgent" today, not a new or worse failure mode.

/** Shallow-copies `record`, dropping every top-level key starting with `_`. Non-object input passes through unchanged. */
function toPublicFeedRecord(record) {
  if (!record || typeof record !== 'object') return record;
  var out = {};
  Object.keys(record).forEach(function (key) {
    if (key.charAt(0) !== '_') out[key] = record[key];
  });
  return out;
}

/** Maps toPublicFeedRecord over an array of records (e.g. get-feed.js's `feed`, get-profile.js's `dreams`). Non-array input returns []. */
function toPublicFeedRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.map(toPublicFeedRecord);
}

module.exports = {
  toPublicFeedRecord: toPublicFeedRecord,
  toPublicFeedRecords: toPublicFeedRecords
};
