// netlify/functions/lib/postpack-selector.js
//
// Pure eligibility + ordering logic for the Instagram/TikTok "post pack"
// MVP (tracker item for-product-instagram-tiktok-auto-postin-cahr76,
// Manager's SPEC v1 — manual-export MVP, no posting APIs). Deliberately a
// plain, dependency-free module (no Blobs, no fetch) so the selection
// POLICY itself — the part with real product judgment in it — can be unit
// tested with a fake seeded feed array, same "pure function, easy to seed
// and assert on" shape as get-feed.js's own pickDreamOfDay/lib/media-status.js's
// classifyMediaUrl. All the actual I/O (reading the shared feed, reading
// moderation reports, dedup-store writes) lives in the caller
// (assemble-instagram-tiktok-postpack.js), not here.
//
// ELIGIBILITY (a published feed record qualifies for a post pack IFF all
// of the following hold):
//   - `channelLicenseGrantedAt` is truthy — a real republish-license grant
//     on file. Absent/null means either published before the clause
//     shipped (deliberately never backfilled — see js/store.js's
//     publishDream/publish-dream.js's own header comments) or the dream
//     was never actually published under it; either way, no license, no
//     eligibility.
//   - `channelLicenseRevokedAt` is falsy — an unpublish/delete/opt-out
//     after the grant ends the license going forward (see
//     js/store.js's unpublishDream/deleteDream/setOkToFeatureOnChannels).
//   - `okToFeatureOnChannels` is not `=== false` — the zero-click,
//     default-ON per-dream opt-out toggle (js/store.js's
//     setOkToFeatureOnChannels). Absent/undefined means "on" (matches
//     publish-dream.js's own `!== false` default), never treated as "off".
//   - the dream's `id` is not in the caller-supplied `reportedDreamIds`
//     set — a founder- or user-filed content report
//     (report-dream.js/lib/moderation-store.js) takes this dream out of
//     consideration entirely. No severity/status distinction in v1 — ANY
//     report at all is enough to exclude it, matching this feature's own
//     "skip anything the founder or a user has flagged/reported" spec
//     line; there is no automated "report was reviewed and dismissed"
//     state anywhere in this codebase yet (get-moderation-reports.js is
//     read-only), so treating every filed report as a permanent exclusion
//     is the only honest behavior available — a human can always just
//     never publish through this channel that dream some other way if a
//     report turns out to be spurious; this feature has no "un-exclude"
//     path by design (out of Phase 1 scope).
//   - has real media to post: at least one of `videoUrl`/`imageUrl`
//     present. Every real feed record already satisfies this (publish-
//     dream.js requires one or the other to publish at all — see that
//     file's own E3), but this is checked defensively rather than assumed,
//     matching admin-media-library-data.js's own itemsForRecord posture of
//     never trusting a record's shape blindly.
//
// ORDERING: newest-published-first, per the spec's own "newest
// published-with-consent dreams first" line — sorted by `publishedAt`
// descending (the same field get-feed.js/admin-media-library-data.js
// already treat as this record type's canonical timestamp; there is no
// separate `createdAt` on a feed record — see admin-media-library-data.js's
// own header comment on that). A record with no `publishedAt` at all sorts
// last (treated as 0), rather than crashing or floating unpredictably.
//
// Never-repeat-across-history and max-1-per-day-per-channel are NOT this
// module's job — those are genuine stateful/durable concerns (a dedup
// store), owned by the caller (see assemble-instagram-tiktok-postpack.js's
// own header comment for why it reuses lib/push-dedup-store.js's existing
// markSentOnce/hasSent rather than inventing a new store). This module
// only ever answers "given this feed snapshot and this reported-id set,
// which records COULD be picked, in what order" — a pure function of its
// inputs, with no memory of any previous run.

/** True if `record` currently qualifies for a post pack per the eligibility rules above. */
function isEligible(record, reportedDreamIds) {
  if (!record || !record.id) return false;
  if (!record.channelLicenseGrantedAt) return false;
  if (record.channelLicenseRevokedAt) return false;
  if (record.okToFeatureOnChannels === false) return false;
  if (reportedDreamIds && reportedDreamIds.has(record.id)) return false;
  if (!record.videoUrl && !record.imageUrl) return false;
  return true;
}

/**
 * Returns every eligible record from `feed`, newest-published-first.
 * `reportedDreamIds` is a Set of dream ids to exclude (build from
 * lib/moderation-store.js's getReports — see this module's header comment
 * on why ANY report excludes, not just some triaged subset); pass an empty
 * Set (or omit) if nothing has been reported.
 */
function getEligibleCandidatesNewestFirst(feed, reportedDreamIds) {
  var reported = reportedDreamIds || new Set();
  var list = (feed || []).filter(function (record) { return isEligible(record, reported); });
  list.sort(function (a, b) { return (b.publishedAt || 0) - (a.publishedAt || 0); });
  return list;
}

module.exports = { isEligible: isEligible, getEligibleCandidatesNewestFirst: getEligibleCandidatesNewestFirst };
