// netlify/functions/delete-tracker-item.js
//
// Owner-only write for tracker.html: removes one item by id. Companion to
// add-tracker-item.js — same owner-check-and-403 pattern as
// update-tracker-item.js/admin-paywall-toggle.js, no relaxation: deleting
// isn't allowed by guessing an id, only by an authenticated owner request
// naming an id that's actually confirmed to exist first.
//
// Shape validation runs BEFORE the owner check, same ordering discipline
// as update-tracker-item.js/add-tracker-item.js — a malformed request is
// rejected on its own terms regardless of who sent it, before
// authorization even becomes the question.
//
// POST { email, id } -> { deleted: true, id }
//
// Error codes (local to this function, same small-number-scheme reasoning
// as update-tracker-item.js/add-tracker-item.js — a new, standalone
// function, not part of generate-video.js/video-status.js's E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 missing_id          — POST body had no `id`
//   E5 forbidden           — POST body's `email` (normalized) didn't
//                             match OWNER_EMAIL (normalized)
//   E6 item_not_found      — no item with that id exists

var { normalizeEmail } = require('./lib/entitlements');
var trackerStore = require('./lib/tracker-store');

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

  var removed = await trackerStore.deleteItem(event, payload.id);
  if (!removed) {
    return { statusCode: 404, body: JSON.stringify({ error: 'E6: item_not_found' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ deleted: true, id: payload.id }) };
};
