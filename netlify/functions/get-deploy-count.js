// netlify/functions/get-deploy-count.js
//
// Public read side of lib/deploy-log-store.js — "how many real (non-
// skipped) Netlify builds ran today" — tracker item
// for-product-surface-deploys-day-as-a-vis-xld1vk. See that store's own
// header comment for the full race-free write/read design.
//
// No auth required — same reasoning as get-tracker-items.js/
// get-smoke-status.js's own GETs: this is a bare count, not a secret
// credential or personal data, and it's meant to be cheaply checkable
// (admin.html's release-visibility line, a future Board widget, a curl
// from a human) without an owner-gate roundtrip first.
//
// GET -> { date: 'YYYY-MM-DD', count: N }
//   Defaults to today (UTC). Accepts an optional `?date=YYYY-MM-DD` query
//   param (any past date, same store) — used by this repo's own tests and
//   handy for a human spot-checking a specific day, not exposed anywhere
//   in the UI today (admin.html only ever asks for "today").
//
// Error codes (local to this function, same small-number scheme as
// get-tracker-items.js/admin-paywall-toggle.js):
//   E1 method_not_allowed — verb other than GET
//   E2 invalid_date — `date` query param present but not YYYY-MM-DD shape

var deployLogStore = require('./lib/deploy-log-store');

var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var qs = event.queryStringParameters || {};
  var dateStr = qs.date || deployLogStore.utcDateStr();
  if (!DATE_RE.test(dateStr)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E2: invalid_date' }) };
  }

  var count = await deployLogStore.countDeploysForDate(event, dateStr);
  return { statusCode: 200, body: JSON.stringify({ date: dateStr, count: count }) };
};
