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

  // Comment-timestamp ALIASES (Manager root-fix, 2026-08-07, tracker
  // protocol v1): comments store their time in `timestamp`, but two
  // different agent sessions independently wrote freshness scans against
  // `at`/`createdAt`, silently got null for every comment, and concluded
  // "no activity for days" while the other side was posting on schedule —
  // a founder-visible communication breakdown, twice. Rather than hoping
  // every future reader guesses the right field, the READ endpoint now
  // serves all three names with the same value. Response-shaping only —
  // nothing extra is ever persisted (tracker-store's own writers still
  // write exactly `timestamp`). See docs/TRACKER_PROTOCOL.md.
  var shaped = items.map(function (item) {
    if (!Array.isArray(item.comments) || !item.comments.length) return item;
    var comments = item.comments.map(function (c) {
      if (!c || typeof c !== 'object') return c;
      var out = Object.assign({}, c);
      if (out.timestamp !== undefined) {
        if (out.at === undefined) out.at = out.timestamp;
        if (out.createdAt === undefined) out.createdAt = out.timestamp;
      }
      return out;
    });
    return Object.assign({}, item, { comments: comments });
  });
  return { statusCode: 200, body: JSON.stringify({ items: shaped }) };
};
