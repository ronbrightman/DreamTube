// netlify/functions/report-dream.js
//
// POST { dreamId, dreamOwnerHandle?, dreamCaption?, reporterHandle?, reason?,
//        targetType?, commentId?, commentText?, commentAuthorHandle? }
// -> flags a specific published dream (or, since Social Layer v2 slice 2,
// a specific COMMENT on one) into the moderation queue
// (lib/moderation-store.js). Tracker item
// for-product-public-feed-safety-in-app-re-ppuw77 — App Store Guideline
// 1.2 / Google Play's equivalent UGC policy require in-app content
// reporting for a public feed; independent of the store requirement, a
// public feed with real AI-generated content (which can occasionally be
// disturbing or policy-violating) benefits from having this regardless.
//
// Deliberately minimal v1, per that tracker item's own scope: no
// reason-picker taxonomy (a single optional free-text reason is enough),
// no automated action on a report (no auto-hide/auto-suspend — a human
// reads these back later, see get-moderation-reports.js), no login
// required to file one (see lib/moderation-store.js's own header comment
// for why).
//
// dreamOwnerHandle/dreamCaption are an unverified CLIENT-SUPPLIED SNAPSHOT
// of what the reporting browser was actually looking at — see
// lib/moderation-store.js's header comment for why that's an accepted,
// deliberate choice here (same trust level as several other client-context
// fields already accepted elsewhere in this codebase), not something this
// function re-derives from the shared feed itself.
//
// COMMENT TARGET TYPE (Social Layer v2 slice 2 — docs/SOCIAL_LAYER_V2_DESIGN.md's
// own Data/API line: "extend report-dream.js/moderation-store.js with
// comment target type"). Purely ADDITIVE, not a rewrite: `targetType`
// defaults to `'dream'` (every existing caller — explore.html's/u.html's
// "Report this dream" flow — keeps working completely unchanged, no
// payload shape they send today needs to change). js/comment-sheet.js's
// per-comment overflow "Report" item is the one new caller that sends
// `targetType:'comment'` plus a `commentId` (required for that target
// type — a comment report with no comment to point at is meaningless) and
// the SAME "unverified client-supplied snapshot" trust level as
// dreamOwnerHandle/dreamCaption above for `commentText`/`commentAuthorHandle`
// — the reporting browser already has the exact comment on screen, so
// snapshotting what it saw is simpler and more robust than a second
// server-side comment-store lookup that could itself race the comment
// being deleted mid-report.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as submit-support-message.js):
//   E1 method_not_allowed — verb other than POST
//   E2 invalid_json       — POST body wasn't valid JSON
//   E3 dream_id_required  — `dreamId` missing/blank
//   E4 reason_too_long    — `reason` over MAX_REASON_LENGTH characters
//   E5 rate_limited       — MAX_REPORTS_PER_IP_PER_DAY exceeded for today
//                             (same per-IP-cap-on-a-public-endpoint shape
//                             as submit-support-message.js/register-account.js)
//   E6 comment_id_required — `targetType==='comment'` but `commentId` missing/blank

var moderationStore = require('./lib/moderation-store');
var rateLimit = require('./lib/rate-limit');
var crypto = require('crypto');

var MAX_REASON_LENGTH = 500;
var MAX_SNAPSHOT_LENGTH = 2000; // generous cap on caption/handle/comment-text snapshots -- purely defensive, these are just context strings for a human reader, never parsed/executed.
var MAX_REPORTS_PER_IP_PER_DAY_DEFAULT = 20;

function capString(value, max) {
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_json' }) };
  }

  var dreamId = capString(payload.dreamId, MAX_SNAPSHOT_LENGTH);
  if (!dreamId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: dream_id_required' }) };
  }

  var reason = null;
  if (payload.reason !== undefined && payload.reason !== null) {
    var rawReason = String(payload.reason).trim();
    if (rawReason.length > MAX_REASON_LENGTH) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E4: reason_too_long' }) };
    }
    reason = rawReason || null;
  }

  // targetType defaults to 'dream' -- see this file's own COMMENT TARGET
  // TYPE header comment. Any value other than the literal string
  // 'comment' is treated as 'dream' (defensive default, not a rejection --
  // this field only ever changes internal bookkeeping, never a
  // security/permission decision).
  var targetType = payload.targetType === 'comment' ? 'comment' : 'dream';
  var commentId = null;
  if (targetType === 'comment') {
    commentId = capString(payload.commentId, MAX_SNAPSHOT_LENGTH);
    if (!commentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'E6: comment_id_required' }) };
    }
  }

  var maxPerDay = parseInt(process.env.MAX_REPORTS_PER_IP_PER_DAY, 10);
  if (!maxPerDay || maxPerDay <= 0) maxPerDay = MAX_REPORTS_PER_IP_PER_DAY_DEFAULT;
  var ip = rateLimit.clientIp(event);
  var ipLimit = await rateLimit.checkAndIncrement(event, 'report-dream-ip', ip, maxPerDay);
  if (!ipLimit.allowed) {
    return { statusCode: 429, body: JSON.stringify({ error: 'E5: rate_limited' }) };
  }

  var entry = {
    id: crypto.randomBytes(8).toString('hex'),
    dreamId: dreamId,
    dreamOwnerHandle: capString(payload.dreamOwnerHandle, MAX_SNAPSHOT_LENGTH),
    dreamCaption: capString(payload.dreamCaption, MAX_SNAPSHOT_LENGTH),
    reporterHandle: capString(payload.reporterHandle, MAX_SNAPSHOT_LENGTH),
    reason: reason,
    targetType: targetType,
    commentId: commentId,
    commentText: targetType === 'comment' ? capString(payload.commentText, MAX_SNAPSHOT_LENGTH) : null,
    commentAuthorHandle: targetType === 'comment' ? capString(payload.commentAuthorHandle, MAX_SNAPSHOT_LENGTH) : null,
    createdAt: new Date().toISOString()
  };

  await moderationStore.appendReport(event, entry);

  // Owner notification (founder gap-report 2026-08-07: he filed a test
  // report and "never got an email" — v1 stored reports silently, and a
  // queue nobody is told about is a queue nobody reads). Fire-and-forget
  // through the same Resend infra every other sender uses: a failure
  // must never turn a successfully-stored report into a failed response
  // (the report IS stored either way — the email is a courtesy ping).
  // OWNER_EMAIL is the same env owner-topup-tokens.js already trusts.
  try {
    var resendKey = process.env.RESEND_API_KEY;
    var ownerEmail = process.env.OWNER_EMAIL;
    if (resendKey && ownerEmail) {
      var subjectKind = targetType === 'comment' ? 'comment' : 'dream';
      var lines = [
        'A ' + subjectKind + ' was reported on the public feed.',
        '',
        'Dream: ' + (entry.dreamCaption || entry.dreamId),
        'Owner: ' + (entry.dreamOwnerHandle || 'unknown'),
        'Reported by: ' + (entry.reporterHandle || 'anonymous'),
        'Reason: ' + (entry.reason || '(none given)'),
        targetType === 'comment' ? ('Comment: "' + (entry.commentText || '') + '" — by ' + (entry.commentAuthorHandle || 'unknown')) : '',
        '',
        'This email carries the full report — there is no review page yet',
        '(get-moderation-reports.js has the queue; page tracked on the tracker).'
      ].filter(Boolean);
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'DreamTube <dreams@dreamtube.life>',
          to: [ownerEmail],
          subject: 'DreamTube report: ' + subjectKind + ' flagged (' + (entry.reason || 'no reason') + ')',
          text: lines.join('\n')
        })
      });
    } else {
      console.log('report-dream: owner notification skipped (RESEND_API_KEY or OWNER_EMAIL not configured)');
    }
  } catch (e) {
    console.log('report-dream: owner notification failed (report itself stored fine): ' + (e && e.message));
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
