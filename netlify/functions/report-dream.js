// netlify/functions/report-dream.js
//
// POST { dreamId, dreamOwnerHandle?, dreamCaption?, reporterHandle?, reason? }
// -> flags a specific published dream into the moderation queue
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
// Error codes (local to this function, same small-number-scheme reasoning
// as submit-support-message.js):
//   E1 method_not_allowed — verb other than POST
//   E2 invalid_json       — POST body wasn't valid JSON
//   E3 dream_id_required  — `dreamId` missing/blank
//   E4 reason_too_long    — `reason` over MAX_REASON_LENGTH characters
//   E5 rate_limited       — MAX_REPORTS_PER_IP_PER_DAY exceeded for today
//                             (same per-IP-cap-on-a-public-endpoint shape
//                             as submit-support-message.js/register-account.js)

var moderationStore = require('./lib/moderation-store');
var rateLimit = require('./lib/rate-limit');
var crypto = require('crypto');

var MAX_REASON_LENGTH = 500;
var MAX_SNAPSHOT_LENGTH = 2000; // generous cap on caption/handle snapshots -- purely defensive, these are just context strings for a human reader, never parsed/executed.
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
    createdAt: new Date().toISOString()
  };

  await moderationStore.appendReport(event, entry);

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
