// netlify/functions/lib/moderation-store.js
//
// Backing store for report-dream.js — the "flags into a moderation queue"
// half of the public-feed-safety build (tracker item
// for-product-public-feed-safety-in-app-re-ppuw77, App Store Guideline 1.2 /
// Google Play's equivalent UGC policy: in-app content reporting). Not a
// Netlify Function itself — a plain module report-dream.js/
// get-moderation-reports.js both require(), matching this codebase's
// existing "self-contained function, shared bits in a plain require()"
// pattern (see lib/support-store.js, lib/tracker-store.js).
//
// A DEDICATED store, not folded into tracker-store.js's items list: a
// content report is a different shape (tied to a specific dream, with a
// reporter/reason/snapshot) and a different lifecycle (append-only writes,
// with one narrow later-mutation for the handled marker below — see that
// section's own comment) from tracker.html's own full priority/waitingFor/
// done workflow items — forcing it into that schema would mean either
// dropping fields tracker-store.js doesn't model or growing that file's
// schema for a use case it was never designed around. This mirrors
// lib/support-store.js's own reasoning almost exactly (a support message
// isn't a tracker item either) — same "small single-purpose store"
// convention, adapted for a different record shape.
//
// Backed by a single Netlify Blobs store ("dreamtube-moderation-reports"),
// ONE KEY ("reports") whose value is the full array — same small-record
// singleton-key pattern as support-store.js's "messages" key. Uses Blobs'
// default eventual consistency (not strong) — same reasoning as every
// other Blobs-backed store in this codebase: strong consistency threw
// BlobsConsistencyError unconditionally in this deploy environment.
//
// Report shape: { id, dreamId, dreamOwnerHandle, dreamCaption,
//   reporterHandle: string|null, reason: string|null,
//   targetType: 'dream'|'comment', commentId: string|null,
//   commentText: string|null, commentAuthorHandle: string|null,
//   createdAt (ISO), handled: boolean, dismissedAt: string|null (ISO) }
//
// handled/dismissedAt (added for moderation-x7q4.html, tracker item
// for-product-build-the-moderation-review--sbf5ol) are the founder's own
// "I've looked at this report" marker — modeled exactly like
// tracker-store.js's reviewedAt/startedAt precedent: a one-way signal (see
// markHandled below — there is no un-handle operation), set the moment the
// founder clicks the review page's dismiss control. Every report written
// before this field existed simply has no `handled` key at all (not a
// placeholder `false`) — get-moderation-reports.js needed no change for
// this (see this file's own COMMENT TARGET TYPE precedent two paragraphs
// down for why an additive field never requires touching the read side),
// and moderation-x7q4.html treats a missing `handled` the same as `false`.
//
// targetType/commentId/commentText/commentAuthorHandle were ADDED
// (additively, not a schema rewrite) for Social Layer v2 slice 2 —
// report-dream.js's own COMMENT TARGET TYPE header comment has the full
// "why". This module itself needed no code change for that addition — it
// already treats `entry` as an opaque, pre-validated record built entirely
// by its caller (see appendReport's own doc comment), so a wider entry
// shape passes through unchanged. Every report written before slice 2
// simply has targetType:'dream' (the field's own default) and null for the
// three comment-only fields, not a placeholder value; get-moderation-reports.js
// needed no change either, for the same "opaque passthrough" reason.
//
// dreamOwnerHandle/dreamCaption are CLIENT-SUPPLIED SNAPSHOTS, not
// independently re-verified server-side against the shared feed — same
// trust level this codebase already extends to other client-reported
// context (support-store.js's videoCount/daysSinceSignup, generate-video.js's
// client-supplied email). This is deliberate, not an oversight: the
// reporting browser already has the exact dream record on screen (it's
// rendering it right now), snapshotting what IT saw at report time is
// simpler and more robust than a second server-side feed lookup (which
// could itself race a report against the dream being edited/deleted), and
// nothing here is used for any access-control or spend decision — only for
// a human (the founder) to read back later and judge for himself. Reports
// are read-only from this store's perspective once written; nothing here
// ever un-publishes a dream or auto-actions a report — that's a human
// judgment call, deliberately out of this build's scope (see the tracker
// item's own "no automated content filtering ML" constraint).
//
// reporterHandle is null for a logged-out visitor (Explore has no login
// gate — see explore.html's own header comment) — reporting deliberately
// does NOT require an account, same "report content without a login wall"
// posture most consumer apps take, since requiring login first would
// suppress exactly the reports a distressed/uninvested visitor is least
// likely to push through a signup flow to file.
//
// CONCURRENT-WRITE RACE — same shape as support-store.js's appendMessage
// (see that file's own CONCURRENT-WRITE RACE comment for the full writeup):
// a read-full-array -> push -> setJSON-the-full-array-back cycle, no
// compare-and-swap primitive available in the installed @netlify/blobs SDK.
// Mitigated (not eliminated) the same way: a bounded read-mutate-write-
// then-verify retry loop via the shared lib/blobs-retry.js. Given this is a
// low-frequency, append-only write path (a real user filing a report, not a
// hot loop), the residual risk is accepted here exactly as it already is
// for support-store.js/tracker-store.js.

var { getStore, connectLambda } = require('@netlify/blobs');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-moderation-reports';
var KEY = 'reports';
var MAX_WRITE_ATTEMPTS = 3;

function store() {
  return getStore({ name: STORE_NAME });
}

/** Returns the full reports array (empty if the store has never been written to yet). `event` is the calling function's Lambda event, passed through to connectLambda so this works from any Netlify Function. */
async function getReports(event) {
  connectLambda(event);
  var reports = await store().get(KEY, { type: 'json' });
  return reports || [];
}

/**
 * Appends one new report and persists the full list. `entry` must already
 * be a complete, validated record (shape/validation is the caller's job —
 * see report-dream.js). Returns the entry as stored. Goes through a
 * bounded read-mutate-write-then-verify retry loop — see the
 * CONCURRENT-WRITE RACE comment above for what this does and doesn't
 * protect against. Same "check alreadyPresent by id before concatenating"
 * shape as support-store.js's appendMessage, and for the identical reason:
 * a retry here can be triggered by our OWN verify-read getting a false
 * negative (this store's eventual consistency means a read immediately
 * after our own write isn't guaranteed to see it yet), not only by a real
 * concurrent writer — without the check, that false-negative case would
 * retry into a SECOND real write of the same report once it does
 * propagate, landing `entry` twice.
 */
async function appendReport(event, entry) {
  await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: getReports,
    mutate: function (reports) {
      var alreadyPresent = reports.some(function (r) { return r.id === entry.id; });
      return alreadyPresent ? reports : reports.concat([entry]);
    },
    verify: function (verifyReports) {
      return (verifyReports || []).some(function (r) { return r.id === entry.id; });
    }
  });
  return entry;
}

/**
 * Marks one existing report `handled` (sets `handled: true` and a real
 * `dismissedAt` ISO timestamp) by id. Same read-mutate-write-then-verify
 * shape as appendReport above, and the same one-way-signal idempotency
 * discipline as tracker-store.js's updateItem: if the report is already
 * handled, `mutate` returns the array UNCHANGED (not a fresh `dismissedAt`)
 * so a retry triggered by this call's own eventually-consistent verify-read
 * never clobbers the original dismiss time. Returns the updated report as
 * stored, or `null` if no report with that id exists (the caller — see
 * mark-report-handled.js — turns that into a 404).
 */
async function markHandled(event, id) {
  var updated = null;
  var alreadyHandled = false;
  await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    maxAttempts: MAX_WRITE_ATTEMPTS,
    read: getReports,
    mutate: function (reports) {
      var idx = -1;
      for (var i = 0; i < reports.length; i++) {
        if (reports[i].id === id) { idx = i; break; }
      }
      if (idx === -1) { updated = null; alreadyHandled = false; return reports; }
      if (reports[idx].handled) {
        // Already handled — idempotent no-op, leaves the original
        // dismissedAt untouched (see this function's own doc comment).
        updated = reports[idx];
        alreadyHandled = true;
        return reports;
      }
      var next = Object.assign({}, reports[idx], { handled: true, dismissedAt: new Date().toISOString() });
      updated = next;
      alreadyHandled = false;
      var out = reports.slice();
      out[idx] = next;
      return out;
    },
    verify: function (verifyReports) {
      if (updated === null) return true; // not found — nothing to verify, stop immediately
      if (alreadyHandled) return true; // no write to verify — stop immediately
      var found = (verifyReports || []).filter(function (r) { return r.id === id; })[0];
      return !!(found && found.handled);
    }
  });
  return updated;
}

module.exports = { STORE_NAME, KEY, getReports, appendReport, markHandled };
