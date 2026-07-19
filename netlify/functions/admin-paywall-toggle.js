// netlify/functions/admin-paywall-toggle.js
//
// Lets the founder flip the paywall on/off from inside the product
// (admin.html) instead of editing PAYWALL_ENABLED in Netlify's dashboard
// and redeploying. See netlify/functions/lib/paywall-settings.js for the
// Blobs-backed override this reads/writes, and generate-video.js's gate
// for the precedence this override takes over PAYWALL_ENABLED.
//
// GET [?email=...] -> { enabled, source } — the current *effective* state
//         (override if one has been set, else the env-var default), same
//         shape/values paywall-settings.js's isPaywallEnabled returns. No
//         auth required to read this part — the on/off state isn't
//         sensitive, and admin.html needs it to render the toggle's
//         current position. If an `email` query param is present, the
//         response also includes `isOwner: boolean` (normalized-email
//         match against OWNER_EMAIL) — this is what admin.html uses to
//         decide whether to render its controls at all, since OWNER_EMAIL
//         itself is a server-only env var the client has no other way to
//         compare against. Same as everywhere else in this app that
//         checks client-supplied identity: this is a UX convenience (don't
//         show the toggle to random logged-in users), not the security
//         boundary — POST below independently re-checks the email itself.
// POST { enabled, email } -> sets the override. `enabled` must be a real
//         boolean. `email` is checked against OWNER_EMAIL (normalized the
//         same way entitlements.js normalizes every other email in this
//         codebase — trim + lowercase, via the shared helper, not a
//         reimplementation) and the request is rejected with 403 unless it
//         matches. This mirrors this codebase's existing, documented
//         pattern of trusting client-supplied identity for account-scoping
//         (see generate-video.js's `email` param, js/store.js's whole
//         account model) rather than building a heavier real-auth system
//         that would be inconsistent with how the rest of this app works —
//         it is a real boundary (only a request naming the exact owner
//         email can flip this) but not a cryptographically strong one, same
//         tradeoff already accepted everywhere else identity is checked
//         here.
//
// Error codes (local to this function, same small-number-scheme reasoning
// as create-checkout-session.js/stripe-webhook.js — this is a new,
// standalone function, not part of generate-video.js/video-status.js's
// E1xx/E2xx generation-flow chain):
//   E1 method_not_allowed        — verb other than GET/POST
//   E2 missing_owner_email       — OWNER_EMAIL not configured in this
//                                   environment, so no request could ever
//                                   be authorized to write the override
//   E3 invalid_json              — POST body wasn't valid JSON
//   E4 enabled_must_be_boolean   — POST body's `enabled` wasn't true/false
//   E5 forbidden                 — POST body's `email` (normalized) didn't
//                                   match OWNER_EMAIL (normalized)

var { normalizeEmail } = require('./lib/entitlements');
var paywallSettings = require('./lib/paywall-settings');

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var state = await paywallSettings.isPaywallEnabled(event);
    var queryEmail = (event.queryStringParameters && event.queryStringParameters.email) || null;
    if (queryEmail) {
      var ownerEmailForRead = normalizeEmail(process.env.OWNER_EMAIL);
      state.isOwner = !!(ownerEmailForRead && normalizeEmail(queryEmail) === ownerEmailForRead);
    }
    return { statusCode: 200, body: JSON.stringify(state) };
  }

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

  if (typeof payload.enabled !== 'boolean') {
    return { statusCode: 400, body: JSON.stringify({ error: 'E4: enabled_must_be_boolean' }) };
  }

  var requestEmail = normalizeEmail(payload.email);
  if (!requestEmail || requestEmail !== ownerEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'E5: forbidden' }) };
  }

  var enabled = await paywallSettings.setOverride(event, payload.enabled);
  return { statusCode: 200, body: JSON.stringify({ enabled: enabled, source: 'override' }) };
};
