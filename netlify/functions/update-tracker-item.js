// netlify/functions/update-tracker-item.js
//
// Owner-only write for tracker.html: updates one item's `priority`/`done`,
// flips its one-way `started` signal, and/or appends one new entry to its
// `comments` list, by id. Deliberately does NOT allow editing
// title/detail/category through this endpoint — that's seed-authored-or-
// added content, not something this endpoint should let anyone
// accidentally mutate. Adding/removing whole items is add-tracker-item.js/
// delete-tracker-item.js's job now, not a hypothetical this endpoint is
// expected to grow into.
//
// `started` is a new, one-way "go ahead and start this" signal, distinct
// from `done` — Ron clicks it to tell whoever/whatever is picking up an
// item that it's approved to begin, without that meaning the item is
// finished. There's no "un-start" exposed here at all: once `startedAt`
// is set, a later `started: true` on the same item is a no-op (see
// tracker-store.js's updateItem for exactly how).
//
// `comment` here means "one new entry to append", not "the new value of
// a field" — see tracker-store.js's own SCHEMA CHANGE comment above
// getItems() for the full comment -> comments migration story. This
// endpoint builds the actual stored entry ({ id, author, text, timestamp
// }) itself from the request's `comment`/`commentAuthor` fields — the id
// and timestamp are always server-generated, never trusted from the
// client, same reasoning as add-tracker-item.js never trusting a
// client-supplied item id.
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
// tracker.html's two comment compose areas ("Your comment" /
// "Claude's comment") both call this same endpoint — only the owner's
// own browser session can even load tracker.html's content in the first
// place (see that file's own doc comment), so `commentAuthor` is just a
// self-declared label distinguishing whose voice a given entry
// represents, not a second, weaker auth boundary. This deliberately
// reuses the existing owner-email check rather than inventing new auth
// for a second "identity".
//
// POST { id, email, priority?, done?, started?, comment?, commentAuthor?
//   } -> { item } (the full updated item)
//   At least one of priority/done/started/comment must be present.
//   priority must be one of "high"/"medium"/"low" if present; done must
//   be a real boolean if present; started, if present, must be exactly
//   `true` (this endpoint never accepts `started: false` — there is no
//   un-start operation). comment, if present, must be a non-empty string
//   of at most MAX_COMMENT_LENGTH characters (unlike the old single
//   `comment` field, an empty string is no longer meaningful here —
//   there's nothing to "clear", appending an empty note isn't a valid
//   entry) and commentAuthor must be present and be exactly "ron" or
//   "claude".
//
// Error codes (local to this function, same small-number-scheme reasoning
// as admin-paywall-toggle.js — a new, standalone function, not part of
// generate-video.js/video-status.js's E1xx/E2xx generation-flow chain):
//   E1  method_not_allowed  — verb other than POST
//   E2  missing_owner_email — OWNER_EMAIL not configured in this
//                              environment, so no request could ever be
//                              authorized
//   E3  invalid_json        — POST body wasn't valid JSON
//   E4  missing_id          — POST body had no `id`
//   E5  no_fields_to_update — none of `priority`/`done`/`started`/
//                              `comment` was present
//   E6  invalid_priority    — `priority` present but not high/medium/low
//   E7  invalid_done        — `done` present but not a real boolean
//   E8  forbidden           — POST body's `email` (normalized) didn't
//                              match OWNER_EMAIL (normalized)
//   E9  item_not_found      — no item with that id exists
//   E10 invalid_comment     — `comment` present but not a non-empty
//                              string, or longer than MAX_COMMENT_LENGTH
//                              characters, or `commentAuthor` isn't
//                              present/valid alongside it
//   E11 invalid_started     — `started` present but not exactly `true`

var { normalizeEmail } = require('./lib/entitlements');
var trackerStore = require('./lib/tracker-store');

var VALID_PRIORITIES = ['high', 'medium', 'low'];
var VALID_COMMENT_AUTHORS = ['ron', 'claude'];
var MAX_COMMENT_LENGTH = 2000;

function generateCommentId() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

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
  var hasStarted = Object.prototype.hasOwnProperty.call(payload, 'started');
  var hasComment = Object.prototype.hasOwnProperty.call(payload, 'comment');
  if (!hasPriority && !hasDone && !hasStarted && !hasComment) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: no_fields_to_update' }) };
  }
  if (hasPriority && VALID_PRIORITIES.indexOf(payload.priority) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_priority' }) };
  }
  if (hasDone && typeof payload.done !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_done' }) };
  }
  // A new comment entry is never an empty string (nothing to "clear" —
  // this is an append-only log, not an overwritable field) and always
  // needs a valid, recognized author alongside it.
  if (hasComment && (
    typeof payload.comment !== 'string' ||
    !payload.comment.trim() ||
    payload.comment.length > MAX_COMMENT_LENGTH ||
    VALID_COMMENT_AUTHORS.indexOf(payload.commentAuthor) === -1
  )) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E10: invalid_comment' }) };
  }
  if (hasStarted && payload.started !== true) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E11: invalid_started' }) };
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E8: forbidden' }) };
  }

  var patch = {};
  if (hasPriority) patch.priority = payload.priority;
  if (hasDone) patch.done = payload.done;
  if (hasStarted) patch.started = true;
  if (hasComment) {
    patch.newComment = {
      id: generateCommentId(),
      author: payload.commentAuthor,
      text: payload.comment.trim(),
      timestamp: new Date().toISOString()
    };
  }

  var updated = await trackerStore.updateItem(event, payload.id, patch);
  if (!updated) {
    return { statusCode: 404, body: JSON.stringify({ error: 'E9: item_not_found' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ item: updated }) };
};
