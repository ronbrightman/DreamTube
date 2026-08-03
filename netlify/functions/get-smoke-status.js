// netlify/functions/get-smoke-status.js
//
// Reliability net — public read side of lib/smoke-status-store.js (tracker
// item for-product-reliability-net-spec-v1-smok-x1o5zc). Returns the
// latest known result for every checkGroup+domain both-domain-smoke.js
// and the nightly seeded-journeys run (via report-smoke-status.js) have
// ever written, so the Board/a morning-report channel/a human or Manager
// checking in has one place to see current health at a glance instead of
// grepping function logs.
//
// No auth required to read — same reasoning as get-tracker-items.js's own
// header comment: nothing in this store is a secret credential or
// personal data (page/endpoint pass-fail status, not user content), and
// this is meant to be cheaply checkable by anything that wants to render
// it (a future Board widget, a curl from a human). Real gating (who can
// WRITE a result) lives on report-smoke-status.js instead — see that
// file's own header comment.
//
// GET -> { checks: [...] }, newest-checked first — see
// lib/smoke-status-store.js's getAllResults for the exact record shape
// each item carries.
//
// Error codes (local to this function, same small-number scheme as
// get-tracker-items.js/admin-paywall-toggle.js):
//   E1 method_not_allowed — verb other than GET

var smokeStatusStore = require('./lib/smoke-status-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var checks = await smokeStatusStore.getAllResults(event);
  return { statusCode: 200, body: JSON.stringify({ checks: checks }) };
};
