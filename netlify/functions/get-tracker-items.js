// netlify/functions/get-tracker-items.js
//
// Returns every tracker item (open tasks + ideas) for tracker.html,
// DreamTube's owner-only "everything still open" list — see
// netlify/functions/lib/tracker-store.js for the storage/seeding details.
//
// No auth required to read — same reasoning as admin-paywall-toggle.js's
// GET: the item list isn't sensitive (nothing here is a secret credential
// or personal data), and tracker.html needs it before it can even decide
// whether to show its own owner-gated UI. Real gating happens client-side
// (tracker.html hides its whole content behind an isOwner check against
// admin-paywall-toggle.js's existing owner-check GET, mirroring
// admin.html exactly) plus server-side on each of the three write
// endpoints (update-tracker-item.js, add-tracker-item.js,
// delete-tracker-item.js) — this endpoint is read-only, so there's
// nothing here for a non-owner to actually mutate even if they called it
// directly.
//
// GET -> { items: [...] } — see tracker-store.js for the item shape and
//         first-call seeding behavior.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js — a new, standalone function):
//   E1 method_not_allowed — verb other than GET

var trackerStore = require('./lib/tracker-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var items = await trackerStore.getItems(event);
  return { statusCode: 200, body: JSON.stringify({ items: items }) };
};
