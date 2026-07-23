// netlify/functions/add-tracker-item.js
//
// Owner-only write for tracker.html: appends a brand-new item (task or
// idea) to the tracker list. This is the real add path — before this,
// every new item was added by hand-editing SEED_ITEMS in
// netlify/functions/lib/tracker-store.js and pushing to main, which only
// ever has any effect on a fresh environment's very first read (see that
// file's own doc comment). Companion to delete-tracker-item.js.
//
// Same owner-check-and-403 pattern as update-tracker-item.js/
// admin-paywall-toggle.js: trusts client-supplied identity (an `email`
// field, checked against OWNER_EMAIL, normalized) as the real boundary —
// same tradeoff already accepted everywhere else in this codebase (see
// admin-paywall-toggle.js's own doc comment for the fuller reasoning).
// Shape validation runs BEFORE the owner check, same ordering discipline
// as update-tracker-item.js — a malformed request is rejected on its own
// terms regardless of who sent it, before authorization even becomes the
// question.
//
// POST { email, category, title, detail, priority? } -> { item } (the
//   full created item, including its server-generated id)
//   category must be "task" or "idea". title/detail must be non-empty
//   strings, capped at 200/4000 chars respectively (same
//   cap-something-reasonable spirit as update-tracker-item.js's
//   priority/done validation). priority is optional and defaults to
//   "medium" if omitted; if present it must be one of high/medium/low.
//   The created item always starts at done: false, comments: [],
//   doneAt: null, startedAt: null, and a real createdAt (the current
//   server time — see tracker-store.js's addItem for why this differs
//   from SEED_ITEMS' null fallback). Its id is generated server-side (see
//   tracker-store.js's generateId), never trusted from the client, so a
//   caller can't collide with or silently overwrite an existing item by
//   choosing its id. title/detail are validated against the raw string
//   (so pure-whitespace input is correctly rejected as empty) but trimmed
//   before being persisted — the length caps above are checked pre-trim,
//   so a title/detail that's exactly at a cap plus surrounding
//   whitespace is rejected rather than silently trimmed down to fit.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as update-tracker-item.js/admin-paywall-toggle.js — a new, standalone
// function, not part of generate-video.js/video-status.js's E1xx/E2xx
// generation-flow chain):
//   E1 method_not_allowed  — verb other than POST
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized
//   E3 invalid_json        — POST body wasn't valid JSON
//   E4 invalid_category    — `category` missing or not "task"/"idea"
//   E5 invalid_title       — `title` missing, empty/whitespace-only,
//                             non-string, or over 200 chars
//   E6 invalid_detail      — `detail` missing, empty/whitespace-only,
//                             non-string, or over 4000 chars
//   E7 invalid_priority    — `priority` present but not high/medium/low
//   E8 forbidden           — POST body's `email` (normalized) didn't
//                             match OWNER_EMAIL (normalized)

var { normalizeEmail } = require('./lib/entitlements');
var trackerStore = require('./lib/tracker-store');

var VALID_CATEGORIES = ['task', 'idea'];
var VALID_PRIORITIES = ['high', 'medium', 'low'];
var MAX_TITLE_LENGTH = 200;
var MAX_DETAIL_LENGTH = 4000;

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

  if (VALID_CATEGORIES.indexOf(payload.category) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: invalid_category' }) };
  }

  if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > MAX_TITLE_LENGTH) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E5: invalid_title' }) };
  }

  if (typeof payload.detail !== 'string' || !payload.detail.trim() || payload.detail.length > MAX_DETAIL_LENGTH) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E6: invalid_detail' }) };
  }

  var hasPriority = Object.prototype.hasOwnProperty.call(payload, 'priority');
  if (hasPriority && VALID_PRIORITIES.indexOf(payload.priority) === -1) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E7: invalid_priority' }) };
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E8: forbidden' }) };
  }

  var created = await trackerStore.addItem(event, {
    category: payload.category,
    title: payload.title.trim(),
    detail: payload.detail.trim(),
    priority: hasPriority ? payload.priority : 'medium'
  });

  return { statusCode: 200, body: JSON.stringify({ item: created }) };
};
