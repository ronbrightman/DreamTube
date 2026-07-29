// netlify/functions/get-moderation-reports.js
//
// GET ?email=... -> { reports: [...] } — the read side of the moderation
// queue reports land in (see report-dream.js/lib/moderation-store.js),
// matching this codebase's existing get-support-messages.js precedent (a
// plain, fetchable GET the founder or a later Claude Code session can hit
// to read back what's been flagged).
//
// Owner-gated, same reasoning as get-support-messages.js: a report can
// name a real reporter/dream-owner handle and free-text reason — not as
// sensitive as a support message's raw account PII, but still real-user
// content about real users, not project metadata like tracker.html's
// items — so this stays behind the same owner check rather than being
// left open like get-tracker-items.js/get-feed.js. Requires `email` to
// match OWNER_EMAIL (normalized the same way every other owner-check in
// this codebase already does — see admin-paywall-toggle.js/
// get-support-messages.js for the identical shape) or the request is
// rejected with 403.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as get-support-messages.js):
//   E1 method_not_allowed  — verb other than GET
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized to read this
//   E3 forbidden           — `email` query param (normalized) didn't
//                             match OWNER_EMAIL

var { normalizeEmail } = require('./lib/entitlements');
var moderationStore = require('./lib/moderation-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var queryEmail = normalizeEmail((event.queryStringParameters && event.queryStringParameters.email) || '');
  if (!queryEmail || queryEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E3: forbidden' }) };
  }

  var reports = await moderationStore.getReports(event);
  return { statusCode: 200, body: JSON.stringify({ reports: reports }) };
};
