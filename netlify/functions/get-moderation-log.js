// netlify/functions/get-moderation-log.js
//
// GET ?email=...[&limit=N] -> { records: [...] } — the read side of the
// MODERATION LOG (blocked-generation prompt text; see
// lib/moderation-log-store.js and the capture hooks in generate-video.js /
// generate-image.js). Records come back NEWEST FIRST.
//
// Owner-gated with the EXACT same gate as get-moderation-reports.js /
// add-tracker-item.js: a client-supplied `email` query param, normalized the
// same way (lib/entitlements.normalizeEmail), checked against OWNER_EMAIL. Not
// a new auth scheme — the same client-supplied-identity boundary this codebase
// already accepts for every owner-only endpoint (see admin-paywall-toggle.js's
// own doc comment for the fuller reasoning). This one is if anything MORE
// sensitive than the report queue — it holds the raw explicit/sensitive text
// users tried to generate — so it stays behind the same owner check, never
// left open like get-tracker-items.js / get-feed.js.
//
// `limit` (optional) caps how many records are returned, default 200 (same
// "recent window" spirit as the founder's spec). Any non-positive/unparseable
// value falls back to the default.
//
// Error codes (local to this function, same small-number scheme as
// get-moderation-reports.js):
//   E1 method_not_allowed  — verb other than GET
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment,
//                             so no request could ever be authorized
//   E3 forbidden           — `email` query param (normalized) didn't match
//                             OWNER_EMAIL

var { normalizeEmail } = require('./lib/entitlements');
var moderationLogStore = require('./lib/moderation-log-store');

var DEFAULT_LIMIT = 200;

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var params = event.queryStringParameters || {};
  var queryEmail = normalizeEmail(params.email || '');
  if (!queryEmail || queryEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E3: forbidden' }) };
  }

  var limit = parseInt(params.limit, 10);
  if (!limit || limit <= 0) limit = DEFAULT_LIMIT;

  var records = await moderationLogStore.list(event, { limit: limit });
  return { statusCode: 200, body: JSON.stringify({ records: records }) };
};
