// netlify/functions/get-support-messages.js
//
// GET ?email=... -> { messages: [...] } — the read side of the "dedicated
// place" a later Claude Code session (or the founder himself) can fetch
// support/feedback history from, matching this codebase's existing
// get-tracker-items.js precedent (a plain, fetchable GET a session can
// hit programmatically without needing real Netlify Blobs credentials of
// its own).
//
// UNLIKE get-tracker-items.js, this is owner-gated, not open to anyone:
// tracker.html's items are project meta-data, but a support/feedback
// message contains real user PII (username, email, free-text message
// content) — leaving that readable with no auth at all would be a real
// privacy problem, not just an inconvenience. Requires `email` to match
// OWNER_EMAIL (normalized the same way every other owner-check in this
// codebase already does — see admin-paywall-toggle.js/
// owner-topup-tokens.js for the identical shape) or the request is
// rejected with 403. This is the same "trust client-supplied identity,
// server-confirmed against an env var" tradeoff already accepted
// everywhere else in this app that checks for the owner specifically —
// a real boundary (only a request naming the exact owner email is
// authorized), not a cryptographically strong one.
//
// Error codes (local to this function, same small-number-scheme
// reasoning as admin-paywall-toggle.js):
//   E1 method_not_allowed  — verb other than GET
//   E2 missing_owner_email — OWNER_EMAIL not configured in this
//                             environment, so no request could ever be
//                             authorized to read this
//   E3 forbidden           — `email` query param (normalized) didn't
//                             match OWNER_EMAIL

var { normalizeEmail } = require('./lib/entitlements');
var supportStore = require('./lib/support-store');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'E1: method_not_allowed' }) };
  }

  var ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  if (!ownerEmail) {
    return { statusCode: 500, body: JSON.stringify({ error: 'E2: missing_owner_email' }) };
  }

  var queryEmail = normalizeEmail((event.queryStringParameters && event.queryStringParameters.email) || '');
  if (!queryEmail || queryEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E3: forbidden' }) };
  }

  var messages = await supportStore.getMessages(event);
  return { statusCode: 200, body: JSON.stringify({ messages: messages }) };
};
