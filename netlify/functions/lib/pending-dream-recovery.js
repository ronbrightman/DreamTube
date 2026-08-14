// netlify/functions/lib/pending-dream-recovery.js
//
// CROSS-DEVICE, BY-EMAIL attach of a completed pre-signup generation to the
// account that finally finalized (tracker item
// for-product-passwordless-cross-device-attach — the founder iOS repro
// 2026-08-14 the earlier E304 server-persist does NOT cover).
//
// THE GAP THIS CLOSES: a passwordless funnel visitor enters their email at
// the wall, which starts a pending generation (start-pending-generation.js ->
// lib/pending-dreams.js) BEFORE a durable account exists for that email. The
// fal video FINISHES (dream-webhook.js markReady -> the pending record now
// carries videoUrl + email) while there is still no account. The visitor then
// FINALIZES their account LATER, on a DIFFERENT device (the emailed code/link
// -> login-with-email-code.js / verify-email-link.js), where the device-local
// pendingId is gone. Neither existing recovery path fires:
//   - dream-webhook.js's persistDurableDreamForOwner resolves the owner by
//     accountStore.getByEmail AT COMPLETION time — no account then, so it
//     correctly SKIPs ("no account yet"), and it is never revisited.
//   - claim-pending-generation.js needs the device-local pendingId, gone on
//     the finalizing device.
// So the finished, already-generated video is stranded in pending-dreams,
// never attached to the account — the profile shows 0 dreams.
//
// THE FIX (this module): at finalization, scan pending-dreams BY EMAIL (the
// secondary index lib/pending-dreams.js maintains — no device-local pendingId
// needed) and backfill every COMPLETED record into the account's durable
// journal via dreamStore.backfillServerDream, exactly as the webhook persist
// would have if the account had existed at completion.
//
// AUTH-SAFE by construction: a record is only ever attached when its OWN
// stored `email` matches the just-finalized account's email (the index is
// keyed by that email, AND the per-record email is re-checked here as defense
// in depth). This never weakens the claim-pending-generation ownership rule —
// it enforces the SAME rule (email must match) on a different, safe key
// (the account was just proven, at finalization, to own that inbox).
//
// CONVERGES, NEVER DUPLICATES: backfillServerDream is insert-if-absent keyed
// by sourceOperationName (the SAME dedup key the E304 fix uses), so a record
// attached here and a later client dream-sync for the same generation collapse
// to ONE journal entry — see lib/dream-store.js's DEDUP-BY-OPERATION block.
//
// BEST-EFFORT, NEVER THROWS: this runs as a side effect of a login/verify that
// has ALREADY succeeded — a failure here must never break that finalization.
// The whole scan is wrapped; a bad record is skipped, not fatal.

var pendingDreams = require('./pending-dreams');
var dreamStore = require('./dream-store');

// Bound the per-finalization work: an email that hit the funnel many times
// could accumulate many pending records. This is a generous ceiling (a real
// user has at most a handful of stranded generations); it exists only so a
// pathological/adversarial email can never turn one finalization into an
// unbounded scan. A completed record beyond this bound still recovers via the
// admin repair tool / the next finalization, an honest degrade.
var MAX_RECORDS_PER_FINALIZATION = 50;

/**
 * Builds the durable private-dream record shape for a COMPLETED pending-dreams
 * `record` owned by `username`, with `mediaUrl` the finished video/image URL.
 * Extracted so dream-webhook.js's own server-side persist and this module's
 * cross-device backfill produce a BYTE-IDENTICAL shape and can never drift —
 * exactly the field set dream-sync.js's sanitizeDream produces (id,
 * ownerHandle, isPublished:false, likes:0, likedByMe:false + the dream fields
 * + createdAt), so a record restored by reconcilePrivateDreamsFromServer
 * renders identically to a client-synced one. Fields the server can't know at
 * completion (mood, interpretation) are null — the same "never fabricate"
 * convention buildDreamSyncUpsertBody uses; a later client sync fills them in.
 */
function buildDurableDreamFromPendingRecord(record, username, mediaUrl) {
  var mediaType = record.mediaType === 'image' ? 'image' : 'video';
  // Matches finalizeDream's own resolvedStoryText fallback: the human-readable
  // dream text is storyText, falling back to the (engineered) caption when a
  // pre-storyText record has none.
  var human = (typeof record.storyText === 'string' && record.storyText.trim()) ? record.storyText : record.caption;
  return {
    id: dreamStore.serverDreamId(record.operationName),
    ownerHandle: '@' + username,
    isPublished: false,
    likes: 0,
    likedByMe: false,
    caption: human || null,
    promptText: record.caption || null,
    storyText: human || null,
    style: record.style || null,
    mediaType: mediaType,
    videoUrl: mediaType === 'video' ? mediaUrl : null,
    imageUrl: mediaType === 'image' ? mediaUrl : null,
    dur: mediaType === 'video' ? '0:08' : null,
    sourceOperationName: record.operationName,
    interpretationText: null,
    interpretationAt: null,
    mood: null,
    createdAt: (typeof record.createdAt === 'number' && isFinite(record.createdAt)) ? record.createdAt : null,
    updatedAt: Date.now()
  };
}

/** The completed media URL on a pending record, or null if it isn't completed. A video record only ever carries videoUrl, an image record only imageUrl (see lib/pending-dreams.js). A 'pending' (not done) or 'failed' record has neither -> null -> skipped. */
function completedMediaUrl(record) {
  var mediaType = record.mediaType === 'image' ? 'image' : 'video';
  var url = mediaType === 'image' ? record.imageUrl : record.videoUrl;
  return (typeof url === 'string' && url) ? url : null;
}

/**
 * Attaches every COMPLETED pending generation for `email` to `username`'s
 * durable journal — the cross-device, by-email finalization backfill (see this
 * module's header comment). Returns a summary { scanned, attached, existed,
 * failed, skipped } for logging/telemetry; NEVER throws (a failure degrades to
 * a summary with a nonzero `failed`/`skipped`, never a rejected promise), so a
 * caller can `await` it inline in a login/verify path without its own guard.
 *
 * `username` is the just-finalized account's canonical username;
 * `email` its on-file email (already ownership-proven by the finalization
 * itself). Both are required — a missing/empty either is a no-op.
 */
async function attachCompletedPendingDreamsForEmail(event, email, username) {
  var summary = { scanned: 0, attached: 0, existed: 0, failed: 0, skipped: 0 };
  try {
    var normalized = pendingDreams.normalizeEmailKey(email);
    if (!normalized || !username) return summary;

    var ids = await pendingDreams.listIdsByEmail(event, normalized);
    if (ids.length > MAX_RECORDS_PER_FINALIZATION) {
      console.error('pending-dream-recovery: ' + ids.length + ' indexed pending ids for one email — capping at ' + MAX_RECORDS_PER_FINALIZATION);
      ids = ids.slice(0, MAX_RECORDS_PER_FINALIZATION);
    }

    for (var i = 0; i < ids.length; i++) {
      summary.scanned++;
      // Each record is fully isolated: a bad read or a hard write failure on
      // ONE record is counted and skipped, never allowed to abort the scan of
      // the others (a partial recovery still beats none).
      try {
        var record = await pendingDreams.get(event, ids[i]);
        if (!record) { summary.skipped++; continue; } // dangling index pointer (record gone) — harmless

        // OWNERSHIP (defense in depth): the index is already keyed by this
        // email, but never attach a record whose OWN stored email doesn't
        // match the just-finalized account — the same rule
        // claim-pending-generation.js enforces, on a safe key.
        if (pendingDreams.normalizeEmailKey(record.email) !== normalized) { summary.skipped++; continue; }
        if (!record.operationName) { summary.skipped++; continue; } // nothing to dedup/key by
        var mediaUrl = completedMediaUrl(record);
        if (!mediaUrl) { summary.skipped++; continue; } // not completed yet (pending/failed)

        var dream = buildDurableDreamFromPendingRecord(record, username, mediaUrl);
        var persisted = await dreamStore.backfillServerDream(event, username, dream);
        if (persisted && persisted.ok) {
          if (persisted.inserted) summary.attached++; else summary.existed++;
        } else {
          summary.failed++;
        }
      } catch (recErr) {
        summary.failed++;
        console.error('pending-dream-recovery: attach of pending id ' + ids[i] + ' failed (non-fatal)', recErr);
      }
    }
  } catch (e) {
    console.error('pending-dream-recovery: attachCompletedPendingDreamsForEmail failed (non-fatal)', e);
  }
  return summary;
}

module.exports = {
  MAX_RECORDS_PER_FINALIZATION,
  buildDurableDreamFromPendingRecord,
  completedMediaUrl,
  attachCompletedPendingDreamsForEmail
};
