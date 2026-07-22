// netlify/functions/update-tracker-item.js
//
// Owner-only write for tracker.html: updates one item's `priority` and/or
// `done` fields by id. Deliberately does NOT allow editing title/detail/
// category through this endpoint — that's seed-authored-or-added content
// (see tracker-store.js's SEED_ITEMS and addItem()), not something this
// endpoint should let anyone accidentally mutate. Adding/removing whole
// items is add-tracker-item.js/delete-tracker-item.js's job now, not a
// hypothetical this endpoint is expected to grow into.
//
// Same owner-check-and-403 pattern as admin-paywall-toggle.js's POST:
// trusts client-supplied identity (an `email` field, checked against
// OWNER_EMAIL, normalized) as the real boundary, not a UX-only check —
// this is a real, if not cryptographically strong, boundary, the same
// tradeoff already accepted everywhere else in this codebase (see
// admin-paywall-toggle.js's own doc comment for the fuller reasoning).
// Shape validation runs BEFORE the owner check (same order as
// admin-paywall-toggle.js's `enabled`-must-be-boolean check) — a
// malformed request is rejected on its own terms regardless of who sent
// it, before authorization even becomes the question.
//
// POST { id, email, priority?, done? } -> { item } (the full updated item)
//   At least one of priority/done must be present. priority must be one
//   of "high"/"medium"/"low" if present; done must be a real boolean if
//   present.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js — a new, standalone function, not part of
// generate-video.js/video-status.js's E1xx/E2xx generation-flow chain):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this environment,
//                             so no request could ever be authorized
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 missing_id          — POST body had no `id`
//   E5 no_fields_to_update — neither `priority` nor `done` was present
//   E6 invalid_priority    — `priority` present but not high/medium/low
//   E7 invalid_done        — `done` present but not a real boolean
//   E8 forbidden           — POST body's `email` (normalized) didn't match
//                             OWNER_EMAIL (normalized)
//   E9 item_not_found      — no item with that id exists

var { normalizeEmail } = require('./lib/entitlements');
var trackerStore = require('./lib/tracker-store');

var VALID_PRIORITIES = ['high', 'medium', 'low'];

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

  var hasPriority = Object.prototype.hasOwnProperty.call(payload, 'priority');
  var hasDone = Object.prototype.hasOwnProperty.call(payload, 'done');
  if (!hasPriority && !hasDone) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: no_fields_to_update' }) };
  }
  if (hasPriority && VALID_PRIORITIES.indexOf(payload.priority) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_priority' }) };
  }
  if (hasDone && typeof payload.done !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_done' }) };
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E8: forbidden' }) };
  }

  var patch = {};
  if (hasPriority) patch.priority = payload.priority;
  if (hasDone) patch.done = payload.done;

  var updated = await trackerStore.updateItem(event, payload.id, patch);
  if (!updated) {
    return { statusCode: 404, body: JSON.stringify({ error: 'E9: item_not_found' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ item: updated }) };
};
