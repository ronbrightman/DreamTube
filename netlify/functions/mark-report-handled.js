// netlify/functions/mark-report-handled.js
//
// POST { id, email } -> marks one moderation report `handled` (see
// lib/moderation-store.js's markHandled) — the write half of
// moderation-x7q4.html's dismiss control (get-moderation-reports.js
// remains the read side; deliberately a separate small endpoint rather
// than folding this into that GET, matching this codebase's existing
// convention of one small single-purpose function per verb/action rather
// than one function branching on method+action — see
// admin-paywall-toggle.js for the one place in this codebase that DOES
// combine GET+POST in one function, and note even that one keeps a single
// resource/concern; this is a distinct write on a distinct resource).
//
// Same owner-check-and-403 pattern as admin-paywall-toggle.js's POST/
// update-tracker-item.js: trusts a client-supplied `email` field, checked
// against OWNER_EMAIL (normalized the same way every other owner-check in
// this codebase already does), as the real boundary — a real, if not
// cryptographically strong, boundary, same tradeoff already accepted
// everywhere else identity is checked here. Shape validation (missing id)
// runs BEFORE the owner check, same ordering as those two files.
//
// `handled` is a one-way signal (see markHandled's own doc comment) — this
// endpoint has no un-handle operation, matching tracker-store.js's
// started/reviewed precedent. Marking an already-handled report handled
// again is a harmless no-op (200, same shape), not an error.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js/update-tracker-item.js):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized to write this
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 missing_id          — POST body had no `id`
//   E5 forbidden           — `email` (normalized) didn't match OWNER_EMAIL
//   E6 report_not_found    — no report with that id exists

var { normalizeEmail } = require('./lib/entitlements');
var moderationStore = require('./lib/moderation-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E3: invalid_json' }) };
  }

  if (!payload.id || typeof payload.id !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: missing_id' }) };
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E5: forbidden' }) };
  }

  var updated = await moderationStore.markHandled(event, payload.id);
  if (!updated) {
    return { statusCode: 404, body: JSON.stringify({ error: 'E6: report_not_found' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ report: updated }) };
};
